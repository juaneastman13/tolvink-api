import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { OcrService } from '../ocr/ocr.service';
import { CreateWeighTicketDto, UpdateWeighTicketDto } from './weigh-tickets.dto';

// =====================================================================
// OCR Prompt — Weigh Ticket (Balanza) specialization
// Handles both origin (campo/remito) and destination (planta) tickets
// =====================================================================

const WEIGH_TICKET_OCR_PROMPT = `Analizá esta imagen de un ticket de balanza / pesaje de granos.
Extraé los siguientes datos y devolvé SOLO un JSON válido, sin markdown, sin texto adicional.
Cada campo numérico debe ser un número (no string). Si no podés leer un campo, poné null.
Para cada campo extraído, incluí un score de confianza individual (0 a 1).

Formato de respuesta:
{
  "ticketNumber": "número de ticket o comprobante",
  "grossWeight": 0,
  "tareWeight": 0,
  "netWeight": 0,
  "humidity": 0,
  "impurities": 0,
  "temperature": 0,
  "dockage": 0,
  "plate": "patente del camión si aparece",
  "product": "tipo de grano/producto",
  "date": "fecha del ticket (YYYY-MM-DD)",
  "time": "hora (HH:MM)",
  "observations": "cualquier nota adicional visible",
  "fieldConfidence": {
    "ticketNumber": 0.0,
    "grossWeight": 0.0,
    "tareWeight": 0.0,
    "netWeight": 0.0,
    "humidity": 0.0,
    "impurities": 0.0,
    "temperature": 0.0
  },
  "overallConfidence": 0.0
}

Notas importantes:
- Los pesos suelen estar en kg. Si están en toneladas, convertí a kg (multiplicar por 1000).
- Humedad e impurezas son porcentajes (ej: 14.5 significa 14.5%).
- Los tickets pueden ser térmicos impresos, generados por sistema, o manuscritos.
- Si es un remito de campo (pesaje en origen), puede tener formato más simple.
- Buscá variantes de los nombres: "P. Bruto" / "Bruto" / "Peso Bruto", "P. Neto" / "Neto", etc.
- "Merma" o "Descuento" = dockage.`;

@Injectable()
export class WeighTicketsService {
  private readonly logger = new Logger(WeighTicketsService.name);

  constructor(
    private prisma: PrismaService,
    private ocrService: OcrService,
  ) {}

  // ======================== CREATE =====================================

  async create(freightId: string, dto: CreateWeighTicketDto, user: any) {
    await this.assertNotConsulta(freightId, user);
    const type = dto.type || 'destination';

    // Validate role vs ticket type
    this.validateRoleForType(type, user);

    // Validate assignment exists if provided
    if (dto.assignmentId) {
      const assignment = await this.prisma.freightAssignment.findFirst({
        where: { id: dto.assignmentId, freightId },
      });
      if (!assignment) throw new BadRequestException('Asignación no encontrada en este flete');
    }

    // Auto-calculate netWeight
    const netWeight = this.calculateNetWeight(dto.grossWeight, dto.tareWeight, dto.netWeight);

    const ticket = await this.prisma.weighTicket.create({
      data: {
        freightId,
        assignmentId: dto.assignmentId || null,
        type,
        ticketNumber: dto.ticketNumber || null,
        grossWeight: dto.grossWeight ?? null,
        tareWeight: dto.tareWeight ?? null,
        netWeight: netWeight ?? null,
        humidity: dto.humidity ?? null,
        impurities: dto.impurities ?? null,
        dockage: dto.dockage ?? null,
        temperature: dto.temperature ?? null,
        observations: dto.observations || null,
        photoUrl: dto.photoUrl || null,
        registeredById: user.sub,
      },
      include: { registeredBy: { select: { id: true, name: true } } },
    });

    this.logger.log(`WeighTicket created: ${ticket.id} (freight=${freightId}, type=${type})`);
    return ticket;
  }

  // ======================== LIST =======================================

  async findAll(freightId: string, type?: string) {
    const where: any = { freightId };
    if (type && (type === 'origin' || type === 'destination')) {
      where.type = type;
    }

    return this.prisma.weighTicket.findMany({
      where,
      include: { registeredBy: { select: { id: true, name: true } } },
      orderBy: { registeredAt: 'desc' },
    });
  }

  // ======================== LIST ALL (cross-freight, for company) ======

  async findAllForCompany(user: any, query: { type?: string; search?: string; limit?: number; offset?: number }) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No company context');

    const where: any = {
      freight: {
        OR: [
          { companyId },
          { producerCompanyId: companyId },
          { assignments: { some: { transportCompanyId: companyId } } },
        ],
      },
    };
    if (query.type === 'origin' || query.type === 'destination') {
      where.type = query.type;
    }
    if (query.search) {
      where.OR = [
        { ticketNumber: { contains: query.search, mode: 'insensitive' } },
        { freight: { code: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const limit = Math.min(query.limit || 50, 100);
    const offset = query.offset || 0;

    const [items, total] = await Promise.all([
      this.prisma.weighTicket.findMany({
        where,
        include: {
          registeredBy: { select: { id: true, name: true } },
          freight: { select: { id: true, code: true, status: true, originName: true, destName: true, items: { select: { grain: true }, take: 1 } } },
        },
        orderBy: { registeredAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.weighTicket.count({ where }),
    ]);

    return { items, total };
  }

  // ======================== DETAIL =====================================

  async findOne(freightId: string, ticketId: string) {
    const ticket = await this.prisma.weighTicket.findFirst({
      where: { id: ticketId, freightId },
      include: {
        registeredBy: { select: { id: true, name: true } },
        assignment: { select: { id: true, plate: true, driverName: true, tripNumber: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket de pesaje no encontrado');
    return ticket;
  }

  // ======================== UPDATE =====================================

  async update(freightId: string, ticketId: string, dto: UpdateWeighTicketDto, user: any) {
    await this.assertNotConsulta(freightId, user);
    const ticket = await this.prisma.weighTicket.findFirst({
      where: { id: ticketId, freightId },
    });
    if (!ticket) throw new NotFoundException('Ticket de pesaje no encontrado');

    // Validate role vs ticket type
    this.validateRoleForType(ticket.type, user);

    // Recalculate netWeight if gross/tare change
    const grossWeight = dto.grossWeight ?? (ticket.grossWeight ? Number(ticket.grossWeight) : undefined);
    const tareWeight = dto.tareWeight ?? (ticket.tareWeight ? Number(ticket.tareWeight) : undefined);
    const netWeight = this.calculateNetWeight(grossWeight, tareWeight, dto.netWeight);

    const updated = await this.prisma.weighTicket.update({
      where: { id: ticketId },
      data: {
        ...(dto.ticketNumber !== undefined && { ticketNumber: dto.ticketNumber }),
        ...(dto.grossWeight !== undefined && { grossWeight: dto.grossWeight }),
        ...(dto.tareWeight !== undefined && { tareWeight: dto.tareWeight }),
        ...(netWeight !== undefined && { netWeight }),
        ...(dto.humidity !== undefined && { humidity: dto.humidity }),
        ...(dto.impurities !== undefined && { impurities: dto.impurities }),
        ...(dto.dockage !== undefined && { dockage: dto.dockage }),
        ...(dto.temperature !== undefined && { temperature: dto.temperature }),
        ...(dto.observations !== undefined && { observations: dto.observations }),
        ...(dto.photoUrl !== undefined && { photoUrl: dto.photoUrl }),
      },
      include: { registeredBy: { select: { id: true, name: true } } },
    });

    this.logger.log(`WeighTicket updated: ${ticketId}`);
    return updated;
  }

  // ======================== DELETE =====================================

  async remove(freightId: string, ticketId: string) {
    const ticket = await this.prisma.weighTicket.findFirst({
      where: { id: ticketId, freightId },
    });
    if (!ticket) throw new NotFoundException('Ticket de pesaje no encontrado');

    await this.prisma.weighTicket.delete({ where: { id: ticketId } });
    this.logger.log(`WeighTicket deleted: ${ticketId}`);
    return { deleted: true };
  }

  // ======================== OCR =======================================

  async runOcr(freightId: string, ticketId: string, user?: any) {
    if (user) await this.assertNotConsulta(freightId, user);
    const ticket = await this.prisma.weighTicket.findFirst({
      where: { id: ticketId, freightId },
    });
    if (!ticket) throw new NotFoundException('Ticket de pesaje no encontrado');
    if (!ticket.photoUrl) throw new BadRequestException('El ticket no tiene foto asociada');

    // Run OCR with weigh-ticket-specific prompt
    let ocrResult: any;
    try {
      ocrResult = await this.ocrService.analyzeFromUrl(ticket.photoUrl, 'pesaje');
    } catch (err) {
      this.logger.error(`OCR failed for ticket ${ticketId}: ${err.message}`);
      return ticket;
    }

    const datos = ocrResult.datos || {};
    const confidence = ocrResult.confianza;

    // Build update: only fill in fields that are currently null (manual edits have priority)
    const updates: Record<string, any> = {
      ocrData: ocrResult,
      ocrConfidence: confidence,
    };

    if (!ticket.ticketNumber && datos.ticketNumber) updates.ticketNumber = String(datos.ticketNumber);
    if (ticket.grossWeight === null && datos.pesoBruto != null) updates.grossWeight = Number(datos.pesoBruto);
    if (ticket.tareWeight === null && datos.tara != null) updates.tareWeight = Number(datos.tara);
    if (ticket.humidity === null && datos.humedad != null) updates.humidity = Number(datos.humedad);
    if (ticket.impurities === null && datos.impurezas != null) updates.impurities = Number(datos.impurezas);
    if (ticket.temperature === null && datos.temperatura != null) updates.temperature = Number(datos.temperatura);
    if (ticket.dockage === null && datos.merma != null) updates.dockage = Number(datos.merma);

    // Also check English field names from the specialized prompt
    if (ticket.grossWeight === null && datos.grossWeight != null) updates.grossWeight = Number(datos.grossWeight);
    if (ticket.tareWeight === null && datos.tareWeight != null) updates.tareWeight = Number(datos.tareWeight);
    if (ticket.humidity === null && datos.humidity != null) updates.humidity = Number(datos.humidity);
    if (ticket.impurities === null && datos.impurities != null) updates.impurities = Number(datos.impurities);
    if (ticket.temperature === null && datos.temperature != null) updates.temperature = Number(datos.temperature);
    if (ticket.dockage === null && datos.dockage != null) updates.dockage = Number(datos.dockage);

    // Recalculate netWeight if gross+tare now available and netWeight is still null
    if (ticket.netWeight === null) {
      const gross = updates.grossWeight ?? (ticket.grossWeight ? Number(ticket.grossWeight) : undefined);
      const tare = updates.tareWeight ?? (ticket.tareWeight ? Number(ticket.tareWeight) : undefined);
      const ocrNet = datos.pesoNeto ?? datos.netWeight;
      const net = this.calculateNetWeight(gross, tare, ocrNet != null ? Number(ocrNet) : undefined);
      if (net !== undefined) updates.netWeight = net;
    }

    const updated = await this.prisma.weighTicket.update({
      where: { id: ticketId },
      data: updates,
      include: { registeredBy: { select: { id: true, name: true } } },
    });

    this.logger.log(`WeighTicket OCR completed: ${ticketId}, confidence=${confidence}`);
    return updated;
  }

  // ======================== HELPERS ====================================

  private calculateNetWeight(gross?: number, tare?: number, explicit?: number): number | undefined {
    // Explicit netWeight takes priority
    if (explicit != null) return explicit;
    // Auto-calculate if both gross and tare are provided
    if (gross != null && tare != null) return Math.max(0, gross - tare);
    return undefined;
  }

  private validateRoleForType(type: string, user: any): void {
    const userTypes = this.resolveUserTypes(user);

    if (type === 'origin') {
      // Origin tickets: producer or transporter can create
      if (!userTypes.has('producer') && !userTypes.has('transporter') && !userTypes.has('platform_admin')) {
        throw new ForbiddenException('Solo el productor o transportista puede registrar pesaje de origen');
      }
    } else {
      // Destination tickets: plant or transporter can create
      if (!userTypes.has('plant') && !userTypes.has('transporter') && !userTypes.has('platform_admin')) {
        throw new ForbiddenException('Solo la planta o transportista puede registrar pesaje de destino');
      }
    }
  }

  private resolveUserTypes(user: any): Set<string> {
    const types = new Set<string>();
    if (user.companyType) types.add(user.companyType);
    if (Array.isArray(user.companyTypes)) user.companyTypes.forEach((t: string) => types.add(t));
    if (user.role === 'platform_admin') types.add('platform_admin');
    return types;
  }

  /** Block CONSULTA (READONLY) users from mutating weigh tickets */
  private async assertNotConsulta(freightId: string, user: any): Promise<void> {
    const userTypes = this.resolveUserTypes(user);
    if (userTypes.has('plant') || userTypes.has('platform_admin')) return;
    const activeCompanyId = user.activeCompanyId;
    if (!activeCompanyId) return;
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: { destCompanyId: true },
    });
    if (!freight?.destCompanyId) return;
    const access = await this.prisma.companyAccess.findFirst({
      where: { grantorCompanyId: freight.destCompanyId, granteeCompanyId: activeCompanyId, isActive: true, accessLevel: 'READONLY' },
    });
    if (access) throw new ForbiddenException('Usuario CONSULTA no puede realizar esta acción');
  }
}
