// =====================================================================
// TOLVINK — Trucks Controller + Service
// CRUD for fleet (camiones)
// Transporters and Producers with own fleet can manage trucks
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { UUID_RE } from '../common/constants';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsEmail, MaxLength, IsUUID, Matches, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { OcrService } from '../ocr/ocr.service';
import { JwtAuthGuard, invalidateUserActiveCache } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

// ======================== DTOs =======================================

export class CreateTruckDto {
  @ApiProperty({ example: 'ABC-123' })
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9\-\s]{2,20}$/, { message: 'Patente inválida (solo letras, números y guiones)' })
  plate: string;

  @ApiProperty({ required: false, example: 'Scania R500' })
  @IsOptional()
  @MaxLength(100)
  model?: string;

  @ApiProperty({ required: false, description: 'UUID del chofer asignado' })
  @IsOptional()
  @IsUUID()
  assignedUserId?: string;

  @ApiProperty({ required: false, description: 'Empresa dueña lógica (cuando planta crea para transportista/productor)' })
  @IsOptional()
  @IsUUID()
  ownerCompanyId?: string;
}

export class CreateDriverDto {
  @ApiProperty({ example: 'Juan Pérez' })
  @IsNotEmpty({ message: 'Nombre obligatorio' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ required: false, example: '098765432' })
  @IsOptional()
  @IsString()
  @Matches(/^09\d{7}$/, { message: 'Formato de teléfono inválido (09XXXXXXX)' })
  phone?: string;

  @ApiProperty({ required: false, example: 'juan@email.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class TrucksService {
  private readonly logger = new Logger(TrucksService.name);

  constructor(private prisma: PrismaService, private wa: WhatsAppService, private companyRes: CompanyResolutionService, private ocr: OcrService) {}

  /** Block CONSULTA (READONLY) users from mutations. */
  private async assertNotConsulta(user: any): Promise<void> {
    const isPlant = await this.companyRes.hasCompanyType(user, 'plant');
    if (isPlant || user.role === 'platform_admin') return;
    const activeCompanyId = user.activeCompanyId || user.companyId;
    if (!activeCompanyId) return;
    const access = await this.prisma.companyAccess.findFirst({
      where: { granteeCompanyId: activeCompanyId, isActive: true, accessLevel: 'READONLY' },
    });
    if (access) throw new ForbiddenException('Usuario CONSULTA no puede realizar esta acción');
  }

  async create(dto: CreateTruckDto, user: any) {
    await this.assertNotConsulta(user);
    const effectiveCompanyId = user.activeCompanyId || user.companyId;
    if (!effectiveCompanyId) throw new BadRequestException('No se pudo determinar tu empresa');
    // Allow transporters, producers, and plants (own fleet)
    const ct = user.companyType;
    const cts = Array.isArray(user.companyTypes) ? user.companyTypes : [];
    const allowed = ['transporter', 'producer', 'plant'];
    if (!allowed.includes(ct) && !cts.some((t: string) => allowed.includes(t)) && user.role !== 'platform_admin') {
      throw new ForbiddenException('Solo transportistas, productores o plantas pueden crear camiones');
    }

    // Normalize and check unique plate
    const normalizedPlate = dto.plate.toUpperCase().replace(/\s+/g, '').trim();
    const existing = await this.prisma.truck.findUnique({ where: { plate: normalizedPlate } });
    if (existing) {
      // Allow reactivation of same-company deactivated truck
      if (!existing.active && existing.companyId === effectiveCompanyId) {
        return this.prisma.truck.update({
          where: { id: existing.id },
          data: { active: true, model: dto.model || existing.model, assignedUserId: dto.assignedUserId || existing.assignedUserId },
          include: { assignedUser: { select: { id: true, name: true } } },
        });
      }
      throw new BadRequestException(`La patente ${dto.plate} ya está registrada`);
    }

    // Validate assigned user belongs to same company
    if (dto.assignedUserId) {
      const driver = await this.prisma.user.findFirst({
        where: { id: dto.assignedUserId, companyId: effectiveCompanyId, active: true },
      });
      if (!driver) throw new BadRequestException('Chofer no encontrado en tu empresa');
    }

    // If ownerCompanyId is set, validate CompanyAccess
    if (dto.ownerCompanyId) {
      const access = await this.prisma.companyAccess.findFirst({
        where: {
          grantorCompanyId: effectiveCompanyId,
          granteeCompanyId: dto.ownerCompanyId,
          isActive: true,
        },
      });
      if (!access) throw new ForbiddenException('No hay vinculación activa con esa empresa');
    }

    return this.prisma.truck.create({
      data: {
        plate: normalizedPlate,
        model: dto.model,
        companyId: effectiveCompanyId,
        ownerCompanyId: dto.ownerCompanyId || null,
        assignedUserId: dto.assignedUserId,
      },
      include: { assignedUser: { select: { id: true, name: true } } },
    });
  }

  async list(user: any, companyId?: string) {
    const targetCompanyId = companyId || user.companyId;
    if (!targetCompanyId) return [];

    const isAdmin = user.role === 'platform_admin' || user.isSuperAdmin;
    if (!isAdmin) {
      // Resolve all companies: memberships + companyId + companyByType
      const callerCompanies = await this.companyRes.resolveAllCompanyIds(user);
      if (!callerCompanies.includes(targetCompanyId)) {
        // Plant-centric fallback: check CompanyAccess (plant → linked company)
        const plantId = user.activeCompanyId || user.companyId;
        const hasAccess = plantId ? await this.prisma.companyAccess.findFirst({
          where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
          select: { id: true },
        }) : null;
        if (!hasAccess) {
          this.logger.warn(`list access denied: user=${user.sub} jwt.companyId=${user.companyId} requested=${targetCompanyId} resolvedIds=${JSON.stringify(callerCompanies)}`);
          throw new ForbiddenException('Sin acceso a la flota de esta empresa');
        }
      }
    }

    if (!targetCompanyId) return [];

    // Include trucks owned by this company (created by plant with ownerCompanyId)
    return this.prisma.truck.findMany({
      where: {
        active: true,
        OR: [
          { companyId: targetCompanyId },
          { ownerCompanyId: targetCompanyId },
        ],
      },
      include: { assignedUser: { select: { id: true, name: true } } },
      orderBy: { plate: 'asc' },
    });
  }

  async deactivate(truckId: string, user: any) {
    await this.assertNotConsulta(user);
    const effectiveCompanyId = user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: { id: truckId, OR: [{ companyId: effectiveCompanyId }, { ownerCompanyId: effectiveCompanyId }] },
    });
    if (!truck) throw new NotFoundException('Camión no encontrado');

    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { truckId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
    });
    if (activeAssignments > 0) {
      throw new BadRequestException(`El camión tiene ${activeAssignments} asignación(es) activa(s). Cancele o finalice los viajes antes de desactivarlo.`);
    }

    return this.prisma.truck.update({
      where: { id: truckId },
      data: { active: false },
    });
  }

  // ======================== DRIVER CRUD ================================

  async createDriver(dto: CreateDriverDto, user: any, targetCompanyId?: string) {
    await this.assertNotConsulta(user);
    const body = dto;

    // Resolve target company: own company or linked company (plant cross-company)
    let driverCompanyId = user.companyId;
    if (targetCompanyId && targetCompanyId !== user.companyId) {
      const plantId = user.activeCompanyId || user.companyId;
      const access = await this.prisma.companyAccess.findFirst({
        where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
        select: { id: true, accessLevel: true },
      });
      if (!access) throw new ForbiddenException('No hay vinculación activa con esa empresa');
      if (access.accessLevel === 'READONLY') throw new ForbiddenException('Acceso CONSULTA no permite crear choferes');
      driverCompanyId = targetCompanyId;
    }

    const email = body.email?.trim().toLowerCase() || `chofer_${randomBytes(8).toString('hex')}@tolvink.internal`;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('Ya existe un usuario con ese email');

    if (body.phone?.trim()) {
      const existingPhone = await this.prisma.user.findFirst({ where: { phone: body.phone.trim() } });
      if (existingPhone) throw new BadRequestException('Ya existe un usuario con ese teléfono');
    }

    const driver = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name: body.name.trim(),
          email,
          phone: body.phone?.trim() || null,
          companyId: driverCompanyId,
          activeCompanyId: driverCompanyId,
          role: 'operator',
        },
      });

      await tx.userCompany.create({
        data: {
          userId: newUser.id,
          companyId: driverCompanyId,
          role: 'chofer',
        },
      });

      return newUser;
    });

    // Fire-and-forget: send WhatsApp welcome to driver
    if (driver.phone) {
      const welcomeMsg = `Hola ${driver.name?.split(' ')[0] || ''}! Te registraron como chofer en *Tolvink*.\n\nEscribime por acá para ver tus viajes asignados, iniciar fletes y compartir tu ubicación en tiempo real.`;
      this.wa.sendText(driver.phone, welcomeMsg).catch(err =>
        this.logger.warn(`WhatsApp welcome failed for driver: ${err.message}`),
      );
    }

    return { id: driver.id, name: driver.name, phone: driver.phone, email: driver.email };
  }

  async listDrivers(user: any, targetCompanyId?: string) {
    let driverCompanyId = targetCompanyId || user.companyId;
    if (!driverCompanyId) return [];

    // If requesting drivers of a different company, validate CompanyAccess
    if (targetCompanyId && targetCompanyId !== user.companyId) {
      const isAdmin = user.role === 'platform_admin' || user.isSuperAdmin;
      if (!isAdmin) {
        const plantId = user.activeCompanyId || user.companyId;
        const access = plantId ? await this.prisma.companyAccess.findFirst({
          where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
          select: { id: true },
        }) : null;
        if (!access) throw new ForbiddenException('Sin acceso a los choferes de esta empresa');
      }
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: driverCompanyId, role: 'chofer', active: true },
      include: { user: { select: { id: true, name: true, phone: true, email: true, active: true } } },
    });
    return memberships.filter(m => m.user.active).map(m => ({
      id: m.user.id,
      name: m.user.name,
      phone: m.user.phone,
      email: m.user.email,
    }));
  }

  async deactivateDriver(driverId: string, user: any, targetCompanyId?: string) {
    await this.assertNotConsulta(user);

    // Resolve company: own company or linked company (plant cross-company)
    let driverCompanyId = user.companyId;
    if (targetCompanyId && targetCompanyId !== user.companyId) {
      const plantId = user.activeCompanyId || user.companyId;
      const access = await this.prisma.companyAccess.findFirst({
        where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
        select: { id: true, accessLevel: true },
      });
      if (!access) throw new ForbiddenException('No hay vinculación activa con esa empresa');
      if (access.accessLevel === 'READONLY') throw new ForbiddenException('Acceso CONSULTA no permite desactivar choferes');
      driverCompanyId = targetCompanyId;
    }

    const membership = await this.prisma.userCompany.findFirst({
      where: { userId: driverId, companyId: driverCompanyId, role: 'chofer' },
    });
    if (!membership) throw new NotFoundException('Chofer no encontrado');

    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { driverId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
    });
    if (activeAssignments > 0) {
      throw new BadRequestException(`El chofer tiene ${activeAssignments} viaje(s) activo(s). Cancele o finalice los viajes antes de desactivarlo.`);
    }

    await this.prisma.userCompany.update({
      where: { id: membership.id },
      data: { active: false },
    });

    // Invalidate JWT active cache so deactivated driver is rejected immediately
    invalidateUserActiveCache(driverId);

    return { ok: true };
  }

  // ======================== TRUCK DETAIL ================================

  async getDetail(truckId: string, user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: { id: truckId, OR: [{ companyId }, { ownerCompanyId: companyId }] },
      include: {
        assignedUser: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!truck) throw new NotFoundException('Camión no encontrado');

    const isOwn = truck.companyId === companyId;

    // Linked trucks: return basic info only
    if (!isOwn) {
      return { ...truck, isOwn: false, documents: [], activeFreights: [], totalFreights: 0, totalTons: 0, docsSummary: { total: 0, expired: 0, expiringSoon: 0, valid: 0 } };
    }

    // Own trucks: full detail
    const docs = await this.prisma.truckDocument.findMany({ where: { truckId, companyId }, orderBy: { createdAt: 'desc' } });
    const now = new Date();
    const in30days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const docsWithStatus = docs.map((d: any) => {
      let expiryStatus = 'no_expiry';
      if (d.expiresAt) { if (d.expiresAt < now) expiryStatus = 'expired'; else if (d.expiresAt < in30days) expiryStatus = 'expiring_soon'; else expiryStatus = 'valid'; }
      return { ...d, expiryStatus };
    });

    const [activeAssignments, totalFreights, totalTons] = await Promise.all([
      this.prisma.freightAssignment.findMany({
        where: { truckId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
        include: { freight: { select: { id: true, code: true, status: true, originName: true, destName: true, scheduledAt: true, items: { select: { grain: true, tons: true }, take: 1 } } } },
        orderBy: { createdAt: 'desc' }, take: 10,
      }),
      this.prisma.freightAssignment.count({ where: { truckId } }),
      this.prisma.freightAssignment.aggregate({ where: { truckId, tripStatus: 'finished' }, _sum: { loadedTons: true } }),
    ]);

    return {
      ...truck, isOwn: true,
      documents: docsWithStatus,
      activeFreights: activeAssignments.map((a: any) => ({ ...a.freight, tripStatus: a.tripStatus })),
      totalFreights, totalTons: totalTons._sum.loadedTons || 0,
      docsSummary: { total: docsWithStatus.length, expired: docsWithStatus.filter((d: any) => d.expiryStatus === 'expired').length, expiringSoon: docsWithStatus.filter((d: any) => d.expiryStatus === 'expiring_soon').length, valid: docsWithStatus.filter((d: any) => d.expiryStatus === 'valid').length },
    };
  }

  // ======================== TRUCK DOCUMENTS ==============================

  async listDocuments(truckId: string, user: any, linkedTo?: string, docType?: string) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const where: any = { truckId, companyId };
    if (docType) where.type = docType;
    if (linkedTo === 'expense') where.expenseId = { not: null };
    else if (linkedTo === 'income') where.incomeId = { not: null };
    else if (linkedTo === 'freight') where.freightId = { not: null };
    else if (linkedTo === 'movement') where.movementId = { not: null };
    else if (linkedTo === 'none') where.AND = [{ expenseId: null }, { incomeId: null }, { freightId: null }, { movementId: null }];
    const docs = await this.prisma.truckDocument.findMany({
      where,
      include: {
        expense: { select: { id: true, type: true, date: true } },
        income: { select: { id: true, concept: true, date: true } },
        freight: { select: { id: true, code: true } },
        movement: { select: { id: true, type: true, departureAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    const in30days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return docs.map((d: any) => {
      let expiryStatus = 'no_expiry';
      if (d.expiresAt) {
        if (d.expiresAt < now) expiryStatus = 'expired';
        else if (d.expiresAt < in30days) expiryStatus = 'expiring_soon';
        else expiryStatus = 'valid';
      }
      let linkedType = 'general';
      if (d.expenseId) linkedType = 'expense';
      else if (d.incomeId) linkedType = 'income';
      else if (d.freightId) linkedType = 'freight';
      else if (d.movementId) linkedType = 'movement';
      return { ...d, expiryStatus, linkedType };
    });
  }

  async addDocument(truckId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const { type, name, fileUrl, fileName, mimeType, issuedAt, expiresAt, notes, expenseId, incomeId, freightId, movementId } = body;
    if (!fileUrl || !fileName || !type) throw new BadRequestException('fileUrl, fileName y type son obligatorios');
    return this.prisma.truckDocument.create({
      data: {
        truckId, companyId, type, name: name || null,
        fileUrl, fileName, mimeType: mimeType || null,
        issuedAt: issuedAt ? new Date(issuedAt) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        notes: notes || null, uploadedById: user.sub,
        expenseId: expenseId || null, incomeId: incomeId || null,
        freightId: freightId || null, movementId: movementId || null,
      },
    });
  }

  async updateDocument(truckId: string, docId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId, companyId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.expiresAt !== undefined) data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (body.issuedAt !== undefined) data.issuedAt = body.issuedAt ? new Date(body.issuedAt) : null;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.fileUrl) { data.fileUrl = body.fileUrl; data.fileName = body.fileName || doc.fileName; }
    // Cross-linking
    if (body.expenseId !== undefined) data.expenseId = body.expenseId || null;
    if (body.incomeId !== undefined) data.incomeId = body.incomeId || null;
    if (body.freightId !== undefined) data.freightId = body.freightId || null;
    if (body.movementId !== undefined) data.movementId = body.movementId || null;
    return this.prisma.truckDocument.update({ where: { id: docId }, data });
  }

  async deleteDocument(truckId: string, docId: string, user: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId, companyId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    await this.prisma.truckDocument.delete({ where: { id: docId } });
    return { ok: true };
  }

  async getExpiringDocuments(user: any, days: number) {
    const companyId = user.activeCompanyId || user.companyId;
    const deadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const now = new Date();
    const docs = await this.prisma.truckDocument.findMany({
      where: { companyId, expiresAt: { lte: deadline } },
      include: { truck: { select: { id: true, plate: true, model: true } } },
      orderBy: { expiresAt: 'asc' },
    });
    return docs.map(d => ({
      ...d,
      expiryStatus: d.expiresAt && d.expiresAt < now ? 'expired' : 'expiring_soon',
    }));
  }

  // ======================== TRUCK EXPENSES ================================

  async listExpenses(truckId: string, user: any, from?: string, to?: string) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const where: any = { truckId, companyId };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    return this.prisma.truckExpense.findMany({
      where,
      include: { freight: { select: { id: true, code: true } } },
      orderBy: { date: 'desc' },
    });
  }

  async addExpense(truckId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const { type, description, amount, currency, date, freightId, receiptUrl, receiptName } = body;
    if (!type || amount == null || !date) throw new BadRequestException('type, amount y date son obligatorios');
    return this.prisma.truckExpense.create({
      data: {
        truckId, companyId, type,
        description: description || null,
        amount, currency: currency || 'UYU',
        date: new Date(date),
        freightId: freightId || null,
        receiptUrl: receiptUrl || null,
        receiptName: receiptName || null,
        createdById: user.sub,
      },
    });
  }

  async updateExpense(truckId: string, expenseId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const exp = await this.prisma.truckExpense.findFirst({ where: { id: expenseId, truckId, companyId } });
    if (!exp) throw new NotFoundException('Gasto no encontrado');
    const data: any = {};
    if (body.type !== undefined) data.type = body.type;
    if (body.description !== undefined) data.description = body.description;
    if (body.amount !== undefined) data.amount = body.amount;
    if (body.currency !== undefined) data.currency = body.currency;
    if (body.date !== undefined) data.date = new Date(body.date);
    if (body.freightId !== undefined) data.freightId = body.freightId || null;
    if (body.receiptUrl !== undefined) { data.receiptUrl = body.receiptUrl; data.receiptName = body.receiptName || exp.receiptName; }
    return this.prisma.truckExpense.update({ where: { id: expenseId }, data });
  }

  async deleteExpense(truckId: string, expenseId: string, user: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const exp = await this.prisma.truckExpense.findFirst({ where: { id: expenseId, truckId, companyId } });
    if (!exp) throw new NotFoundException('Gasto no encontrado');
    await this.prisma.truckExpense.delete({ where: { id: expenseId } });
    return { ok: true };
  }

  async getExpenseSummary(truckId: string, user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [byType, thisMonth, prevMonth] = await Promise.all([
      this.prisma.truckExpense.groupBy({ by: ['type'], where: { truckId, companyId }, _sum: { amount: true } }),
      this.prisma.truckExpense.aggregate({ where: { truckId, companyId, date: { gte: startOfMonth } }, _sum: { amount: true } }),
      this.prisma.truckExpense.aggregate({ where: { truckId, companyId, date: { gte: startOfPrevMonth, lt: startOfMonth } }, _sum: { amount: true } }),
    ]);

    return {
      byType: byType.map(t => ({ type: t.type, total: t._sum.amount || 0 })),
      thisMonth: thisMonth._sum.amount || 0,
      prevMonth: prevMonth._sum.amount || 0,
    };
  }

  // ======================== TRUCK FREIGHT HISTORY ==========================

  /** Fleet-wide document expiry alerts — used by HomeScreen */
  async getFleetAlerts(user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    const now = new Date();
    const in7days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const expiredDocs = await this.prisma.truckDocument.findMany({
      where: { companyId, expiresAt: { lte: in7days } },
      select: { truckId: true, expiresAt: true },
    });

    const truckExpired = new Set<string>();
    const truckExpiring = new Set<string>();
    for (const d of expiredDocs) {
      if (d.expiresAt && d.expiresAt < now) truckExpired.add(d.truckId);
      else truckExpiring.add(d.truckId);
    }
    // Remove trucks that are already in expired from expiring
    for (const t of truckExpired) truckExpiring.delete(t);

    return {
      trucksWithExpired: truckExpired.size,
      trucksWithExpiring: truckExpiring.size,
      totalExpiredDocs: expiredDocs.filter(d => d.expiresAt && d.expiresAt < now).length,
      totalExpiringDocs: expiredDocs.filter(d => d.expiresAt && d.expiresAt >= now).length,
    };
  }

  async getFreightHistory(truckId: string, user: any, take = 20, skip = 0) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const assignments = await this.prisma.freightAssignment.findMany({
      where: { truckId, tripStatus: 'finished' },
      include: { freight: { select: { id: true, code: true, status: true, originName: true, destName: true, scheduledAt: true, items: { select: { grain: true, tons: true }, take: 1 } } } },
      orderBy: { finishedAt: 'desc' },
      take, skip,
    });
    return assignments.map((a: any) => ({
      assignmentId: a.id,
      freightId: a.freight.id,
      code: a.freight.code,
      origin: a.freight.originName,
      dest: a.freight.destName,
      date: a.finishedAt || a.freight.scheduledAt,
      grain: a.freight.items?.[0]?.grain,
      tons: a.loadedTons || a.freight.items?.[0]?.tons,
      kmLoaded: a.kmLoaded ? Number(a.kmLoaded) : null,
      kmEmpty: a.kmEmpty ? Number(a.kmEmpty) : null,
      kmTotal: a.kmTotal ? Number(a.kmTotal) : null,
      fuelLiters: a.fuelLiters ? Number(a.fuelLiters) : null,
      fuelCostPerLiter: a.fuelCostPerLiter ? Number(a.fuelCostPerLiter) : null,
      tollCost: a.tollCost ? Number(a.tollCost) : null,
      odometerStart: a.odometerStart,
      odometerEnd: a.odometerEnd,
    }));
  }

  // ======================== TRUCK INCOMES ================================

  async listIncomes(truckId: string, user: any, from?: string, to?: string, status?: string) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const where: any = { truckId, companyId };
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to); }
    if (status) where.status = status;
    return this.prisma.truckIncome.findMany({
      where, include: { freight: { select: { id: true, code: true } } }, orderBy: { date: 'desc' },
    });
  }

  async addIncome(truckId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    if (!body.concept || body.amount == null || !body.date) throw new BadRequestException('concept, amount y date son obligatorios');
    if (body.freightId) await this.validateFreightLink(body.freightId, truckId, companyId);
    return this.prisma.truckIncome.create({
      data: {
        truckId, companyId, concept: body.concept, amount: body.amount,
        currency: body.currency || 'UYU', date: new Date(body.date),
        freightId: body.freightId || null, invoiceNumber: body.invoiceNumber || null,
        invoiceUrl: body.invoiceUrl || null, status: body.status || 'PENDING',
        notes: body.notes || null, createdById: user.sub,
      },
    });
  }

  async updateIncome(truckId: string, incomeId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const inc = await this.prisma.truckIncome.findFirst({ where: { id: incomeId, truckId, companyId } });
    if (!inc) throw new NotFoundException('Ingreso no encontrado');
    if (body.freightId) await this.validateFreightLink(body.freightId, truckId, companyId);
    const data: any = {};
    for (const k of ['concept','amount','currency','date','freightId','invoiceNumber','invoiceUrl','status','notes']) {
      if (body[k] !== undefined) data[k] = k === 'date' ? new Date(body[k]) : (body[k] || null);
    }
    return this.prisma.truckIncome.update({ where: { id: incomeId }, data });
  }

  async deleteIncome(truckId: string, incomeId: string, user: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const inc = await this.prisma.truckIncome.findFirst({ where: { id: incomeId, truckId, companyId } });
    if (!inc) throw new NotFoundException('Ingreso no encontrado');
    await this.prisma.truckIncome.delete({ where: { id: incomeId } });
    return { ok: true };
  }

  async getIncomeSummary(truckId: string, user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const [paid, pending, overdue] = await Promise.all([
      this.prisma.truckIncome.aggregate({ where: { truckId, companyId, status: 'PAID' }, _sum: { amount: true } }),
      this.prisma.truckIncome.aggregate({ where: { truckId, companyId, status: 'PENDING' }, _sum: { amount: true } }),
      this.prisma.truckIncome.aggregate({ where: { truckId, companyId, status: 'OVERDUE' }, _sum: { amount: true } }),
    ]);
    return { paid: paid._sum.amount || 0, pending: pending._sum.amount || 0, overdue: overdue._sum.amount || 0 };
  }

  // ======================== TRUCK MOVEMENTS ==============================

  async listMovements(truckId: string, user: any, from?: string, to?: string, type?: string) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const where: any = { truckId, companyId };
    if (from || to) { where.departureAt = {}; if (from) where.departureAt.gte = new Date(from); if (to) where.departureAt.lte = new Date(to); }
    if (type) where.type = type;
    return this.prisma.truckMovement.findMany({
      where, include: { driver: { select: { id: true, name: true } } }, orderBy: { departureAt: 'desc' },
    });
  }

  async addMovement(truckId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    if (!body.type) throw new BadRequestException('type es obligatorio');
    // Validate field/lot ownership
    await this.validateLocationRefs(companyId, body.originFieldId, body.originLotId, body.destFieldId, body.destLotId);
    const mov = await this.prisma.truckMovement.create({
      data: {
        truckId, companyId, type: body.type, description: body.description || null,
        originName: body.originName || null, originLat: body.originLat || null, originLng: body.originLng || null,
        originFieldId: body.originFieldId || null, originLotId: body.originLotId || null,
        destName: body.destName || null, destLat: body.destLat || null, destLng: body.destLng || null,
        destFieldId: body.destFieldId || null, destLotId: body.destLotId || null,
        departureAt: body.departureAt ? new Date(body.departureAt) : null,
        arrivalAt: body.arrivalAt ? new Date(body.arrivalAt) : null,
        kmDriven: body.kmDriven || null, fuelLiters: body.fuelLiters || null,
        fuelCost: body.fuelCost || null, tollCost: body.tollCost || null,
        driverId: body.driverId || null, notes: body.notes || null, createdById: user.sub,
      },
    });
    // Update truck odometer if km provided
    if (body.kmDriven) await this.updateOdometer(truckId, body.kmDriven);
    return mov;
  }

  async updateMovement(truckId: string, movId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const mov = await this.prisma.truckMovement.findFirst({ where: { id: movId, truckId, companyId } });
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    await this.validateLocationRefs(companyId, body.originFieldId, body.originLotId, body.destFieldId, body.destLotId);
    const data: any = {};
    for (const k of ['type','description','originName','destName','kmDriven','fuelLiters','fuelCost','tollCost','driverId','notes','originLat','originLng','originFieldId','originLotId','destLat','destLng','destFieldId','destLotId']) {
      if (body[k] !== undefined) data[k] = body[k] || null;
    }
    if (body.departureAt !== undefined) data.departureAt = body.departureAt ? new Date(body.departureAt) : null;
    if (body.arrivalAt !== undefined) data.arrivalAt = body.arrivalAt ? new Date(body.arrivalAt) : null;
    return this.prisma.truckMovement.update({ where: { id: movId }, data });
  }

  async deleteMovement(truckId: string, movId: string, user: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const mov = await this.prisma.truckMovement.findFirst({ where: { id: movId, truckId, companyId } });
    if (!mov) throw new NotFoundException('Movimiento no encontrado');
    await this.prisma.truckMovement.delete({ where: { id: movId } });
    return { ok: true };
  }

  // ======================== TRIP DATA ====================================

  async updateTripData(freightId: string, assignmentId: string, user: any, body: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { id: assignmentId, freightId, transportCompanyId: companyId },
    });
    if (!assignment) throw new NotFoundException('Asignación no encontrada');
    const data: any = {};
    for (const k of ['kmLoaded','kmEmpty','kmTotal','loadingMinutes','unloadingMinutes','fuelLiters','fuelCostPerLiter','tollCost','odometerStart','odometerEnd']) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (body.departureAt !== undefined) data.departureAt = body.departureAt ? new Date(body.departureAt) : null;
    if (body.arrivalAt !== undefined) data.arrivalAt = body.arrivalAt ? new Date(body.arrivalAt) : null;
    const updated = await this.prisma.freightAssignment.update({ where: { id: assignmentId }, data });
    // Update truck odometer
    if (body.odometerEnd && assignment.truckId) {
      await this.prisma.truck.updateMany({
        where: { id: assignment.truckId, OR: [{ currentOdometer: null }, { currentOdometer: { lt: body.odometerEnd } }] },
        data: { currentOdometer: body.odometerEnd, lastOdometerDate: new Date() },
      });
    }
    return updated;
  }

  // ======================== ECONOMIC SUMMARY ==============================

  async getEconomicSummary(truckId: string, user: any, from?: string, to?: string) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const dateFilter = (from || to) ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;

    const [incPaid, incPending, incOverdue, expTotal, expByType, freightTrips, movements] = await Promise.all([
      this.prisma.truckIncome.aggregate({ where: { truckId, companyId, status: 'PAID', ...(dateFilter ? { date: dateFilter } : {}) }, _sum: { amount: true } }),
      this.prisma.truckIncome.aggregate({ where: { truckId, companyId, status: 'PENDING', ...(dateFilter ? { date: dateFilter } : {}) }, _sum: { amount: true } }),
      this.prisma.truckIncome.aggregate({ where: { truckId, companyId, status: 'OVERDUE', ...(dateFilter ? { date: dateFilter } : {}) }, _sum: { amount: true } }),
      this.prisma.truckExpense.aggregate({ where: { truckId, companyId, ...(dateFilter ? { date: dateFilter } : {}) }, _sum: { amount: true } }),
      this.prisma.truckExpense.groupBy({ by: ['type'], where: { truckId, companyId, ...(dateFilter ? { date: dateFilter } : {}) }, _sum: { amount: true } }),
      this.prisma.freightAssignment.findMany({
        where: { truckId, tripStatus: 'finished', ...(dateFilter ? { finishedAt: dateFilter } : {}) },
        select: { kmTotal: true, kmLoaded: true, fuelLiters: true, startedAt: true, finishedAt: true, departureAt: true, arrivalAt: true },
      }),
      this.prisma.truckMovement.findMany({
        where: { truckId, companyId, ...(dateFilter ? { departureAt: dateFilter } : {}) },
        select: { kmDriven: true, fuelLiters: true, departureAt: true, arrivalAt: true, type: true },
      }),
    ]);

    const totalIncome = Number(incPaid._sum.amount || 0);
    const totalExpense = Number(expTotal._sum.amount || 0);

    // Km calculations
    const freightKm = freightTrips.reduce((s: number, t: any) => s + Number(t.kmTotal || 0), 0);
    const freightKmLoaded = freightTrips.reduce((s: number, t: any) => s + Number(t.kmLoaded || 0), 0);
    const movementKm = movements.reduce((s: number, m: any) => s + Number(m.kmDriven || 0), 0);
    const totalKm = freightKm + movementKm;

    // Fuel
    const freightFuel = freightTrips.reduce((s: number, t: any) => s + Number(t.fuelLiters || 0), 0);
    const movementFuel = movements.reduce((s: number, m: any) => s + Number(m.fuelLiters || 0), 0);
    const totalFuel = freightFuel + movementFuel;

    // Hours
    const calcHours = (items: any[], depKey: string, arrKey: string) => items.reduce((s: number, i: any) => {
      const dep = i[depKey] || i.startedAt;
      const arr = i[arrKey] || i.finishedAt;
      if (dep && arr) return s + (new Date(arr).getTime() - new Date(dep).getTime()) / 3600000;
      return s;
    }, 0);
    const totalHours = calcHours(freightTrips, 'departureAt', 'arrivalAt') + calcHours(movements, 'departureAt', 'arrivalAt');

    const repoKm = movements.filter((m: any) => m.type === 'REPOSITIONING').reduce((s: number, m: any) => s + Number(m.kmDriven || 0), 0);

    return {
      income: { paid: totalIncome, pending: Number(incPending._sum.amount || 0), overdue: Number(incOverdue._sum.amount || 0), total: totalIncome + Number(incPending._sum.amount || 0) + Number(incOverdue._sum.amount || 0) },
      expenses: { total: totalExpense, byType: expByType.map((t: any) => ({ type: t.type, total: Number(t._sum.amount || 0) })) },
      net: totalIncome - totalExpense,
      km: { total: totalKm, freight: freightKm, freightLoaded: freightKmLoaded, movements: movementKm, productivePercent: totalKm > 0 ? Math.round((freightKmLoaded / totalKm) * 100) : 0 },
      fuel: { totalLiters: totalFuel, kmPerLiter: totalFuel > 0 ? Math.round((totalKm / totalFuel) * 10) / 10 : 0 },
      hours: Math.round(totalHours * 10) / 10,
      trips: { freights: freightTrips.length, movements: movements.length, total: freightTrips.length + movements.length },
      costPerKm: totalKm > 0 ? Math.round((totalExpense / totalKm) * 10) / 10 : 0,
      incomePerKm: totalKm > 0 ? Math.round((totalIncome / totalKm) * 10) / 10 : 0,
    };
  }

  // ======================== FLEET SUMMARY =================================

  async getFleetSummary(user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const trucks = await this.prisma.truck.findMany({
      where: { companyId, active: true },
      select: { id: true, plate: true },
    });
    const truckIds = trucks.map(t => t.id);
    if (truckIds.length === 0) return { totalIncome: 0, totalExpense: 0, net: 0, totalKm: 0, totalTrips: 0, expiredDocs: 0, trucks: [] };

    const [incAgg, expAgg, freightAgg, movAgg, expiredDocs] = await Promise.all([
      this.prisma.truckIncome.groupBy({ by: ['truckId'], where: { companyId, status: 'PAID', date: { gte: startOfMonth } }, _sum: { amount: true } }),
      this.prisma.truckExpense.groupBy({ by: ['truckId'], where: { companyId, date: { gte: startOfMonth } }, _sum: { amount: true } }),
      this.prisma.freightAssignment.groupBy({ by: ['truckId'], where: { truckId: { in: truckIds }, tripStatus: 'finished', finishedAt: { gte: startOfMonth } }, _sum: { kmTotal: true }, _count: true }),
      this.prisma.truckMovement.groupBy({ by: ['truckId'], where: { companyId, departureAt: { gte: startOfMonth } }, _sum: { kmDriven: true }, _count: true }),
      this.prisma.truckDocument.count({ where: { companyId, expiresAt: { lt: now } } }),
    ]);

    // Build per-truck map
    const byTruck: Record<string, any> = {};
    for (const t of trucks) byTruck[t.id] = { id: t.id, plate: t.plate, income: 0, expense: 0, km: 0, trips: 0 };
    for (const r of incAgg) { if (byTruck[r.truckId]) byTruck[r.truckId].income = Number(r._sum.amount || 0); }
    for (const r of expAgg) { if (byTruck[r.truckId]) byTruck[r.truckId].expense = Number(r._sum.amount || 0); }
    for (const r of freightAgg) { if (byTruck[r.truckId]) { byTruck[r.truckId].km += Number(r._sum.kmTotal || 0); byTruck[r.truckId].trips += r._count; } }
    for (const r of movAgg) { if (byTruck[r.truckId]) { byTruck[r.truckId].km += Number(r._sum.kmDriven || 0); byTruck[r.truckId].trips += r._count; } }

    const arr = Object.values(byTruck) as any[];
    arr.forEach((t: any) => t.net = t.income - t.expense);
    arr.sort((a: any, b: any) => b.net - a.net);

    return {
      totalIncome: arr.reduce((s: number, t: any) => s + t.income, 0),
      totalExpense: arr.reduce((s: number, t: any) => s + t.expense, 0),
      net: arr.reduce((s: number, t: any) => s + t.net, 0),
      totalKm: Math.round(arr.reduce((s: number, t: any) => s + t.km, 0)),
      totalTrips: arr.reduce((s: number, t: any) => s + t.trips, 0),
      expiredDocs,
      bestTruck: arr[0]?.net > 0 ? { plate: arr[0].plate, net: arr[0].net } : null,
      trucks: arr,
    };
  }

  // ======================== HELPERS ======================================

  private async updateOdometer(truckId: string, additionalKm: number) {
    const truck = await this.prisma.truck.findUnique({ where: { id: truckId }, select: { currentOdometer: true } });
    if (truck?.currentOdometer) {
      await this.prisma.truck.update({
        where: { id: truckId },
        data: { currentOdometer: truck.currentOdometer + Math.round(additionalKm), lastOdometerDate: new Date() },
      });
    }
  }

  /** Validate that field/lot IDs belong to the user's company */
  private async validateLocationRefs(companyId: string, originFieldId?: string, originLotId?: string, destFieldId?: string, destLotId?: string) {
    for (const fId of [originFieldId, destFieldId]) {
      if (fId) {
        const field = await this.prisma.field.findFirst({ where: { id: fId, OR: [{ companyId }, { ownerCompanyId: companyId }] } });
        if (!field) throw new ForbiddenException('Campo de ubicación no pertenece a tu empresa');
      }
    }
    for (const lId of [originLotId, destLotId]) {
      if (lId) {
        const lot = await this.prisma.lot.findFirst({ where: { id: lId, companyId } });
        if (!lot) throw new ForbiddenException('Lote no pertenece a tu empresa');
      }
    }
  }

  /** Validate that a freight involves this truck and company */
  private async validateFreightLink(freightId: string, truckId: string, companyId: string) {
    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { freightId, truckId, transportCompanyId: companyId },
    });
    if (!assignment) {
      // Also check if freight belongs to company even without truck assignment
      const freight = await this.prisma.freight.findFirst({
        where: { id: freightId, participantCompanyIds: { has: companyId } },
      });
      if (!freight) throw new ForbiddenException('Flete no pertenece a tu empresa o camión');
    }
  }

  private async assertTruckAccess(truckId: string, companyId: string) {
    const truck = await this.prisma.truck.findFirst({
      where: { id: truckId, OR: [{ companyId }, { ownerCompanyId: companyId }] },
    });
    if (!truck) throw new NotFoundException('Camión no encontrado');
    return truck;
  }

  /** Strict check: only the truck's actual company can manage its internal data */
  // ======================== OCR ==========================================

  async processDocOcr(truckId: string, docId: string, user: any) {
    await this.assertNotConsulta(user);
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const doc = await this.prisma.truckDocument.findFirst({ where: { id: docId, truckId, companyId } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    if (!doc.fileUrl) throw new BadRequestException('El documento no tiene archivo');

    // Mark as processing
    await this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrStatus: 'processing' } });

    // Process async (don't block response)
    this.runOcrAsync(docId, doc.fileUrl, doc.type).catch(err => {
      this.logger.error(`OCR async error doc=${docId}: ${err.message}`);
    });

    return { status: 'processing', message: 'Procesando documento con IA...' };
  }

  private async runOcrAsync(docId: string, fileUrl: string, docType: string) {
    try {
      const result = await this.ocr.analyzeFromUrl(fileUrl);
      const update: any = {
        ocrData: result,
        ocrStatus: 'completed',
        ocrProcessedAt: new Date(),
      };
      // Auto-fill expiresAt if OCR detected expiry date and doc doesn't have one
      const doc = await this.prisma.truckDocument.findUnique({ where: { id: docId } });
      if (!doc?.expiresAt && result?.datos) {
        const expiryField = result.datos.fechaVencimiento || result.datos.vigenciaHasta || result.datos.validoHasta || result.datos.expiry;
        if (expiryField) {
          try {
            const parsed = new Date(expiryField);
            if (!isNaN(parsed.getTime())) update.expiresAt = parsed;
          } catch {}
        }
      }
      await this.prisma.truckDocument.update({ where: { id: docId }, data: update });
      this.logger.log(`OCR completed for truck doc ${docId}: type=${result?.tipoDocumento}`);
    } catch (err) {
      await this.prisma.truckDocument.update({ where: { id: docId }, data: { ocrStatus: 'failed' } });
      this.logger.error(`OCR failed for truck doc ${docId}: ${err.message}`);
    }
  }

  async getDocOcr(truckId: string, docId: string, user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    await this.assertTruckOwnership(truckId, companyId);
    const doc = await this.prisma.truckDocument.findFirst({
      where: { id: docId, truckId, companyId },
      select: { ocrData: true, ocrStatus: true, ocrProcessedAt: true, type: true, fileName: true },
    });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    return doc;
  }

  private async assertTruckOwnership(truckId: string, companyId: string) {
    const truck = await this.prisma.truck.findFirst({
      where: { id: truckId, companyId },
    });
    if (!truck) throw new ForbiddenException('Solo podés gestionar camiones de tu empresa');
    return truck;
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Trucks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('trucks')
export class TrucksController {
  constructor(private service: TrucksService) {}

  @Post()
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar camión' })
  create(@Body() dto: CreateTruckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar camiones de la empresa' })
  @ApiQuery({ name: 'companyId', required: false })
  list(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.list(user, companyId);
  }

  @Patch(':id/deactivate')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Desactivar camión' })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivate(id, user);
  }

  // ======================== DRIVER ENDPOINTS =============================

  @Post('drivers')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar chofer para la empresa' })
  @ApiQuery({ name: 'companyId', required: false })
  createDriver(@Body() dto: CreateDriverDto, @CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.createDriver(dto, user, companyId);
  }

  @Get('drivers')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar choferes de la empresa' })
  @ApiQuery({ name: 'companyId', required: false })
  listDrivers(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.listDrivers(user, companyId);
  }

  @Patch('drivers/:id/deactivate')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Desactivar chofer' })
  @ApiQuery({ name: 'companyId', required: false })
  deactivateDriver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.deactivateDriver(id, user, companyId);
  }

  // ======================== FLEET ALERTS (before :id routes) ==============

  @Get('alerts')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Alertas de documentos vencidos/por vencer de la flota' })
  getFleetAlerts(@CurrentUser() user: any) {
    return this.service.getFleetAlerts(user);
  }

  @Get('fleet-summary')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Resumen económico de toda la flota (mes actual)' })
  getFleetSummary(@CurrentUser() user: any) {
    return this.service.getFleetSummary(user);
  }

  @Get('documents/expiring')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Documentos próximos a vencer' })
  @ApiQuery({ name: 'days', required: false })
  getExpiringDocuments(@CurrentUser() user: any, @Query('days') days?: string) {
    return this.service.getExpiringDocuments(user, days ? parseInt(days, 10) : 30);
  }

  // ======================== TRUCK DETAIL ==================================

  @Get(':id')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Detalle del camión con docs, fletes y gastos' })
  getDetail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getDetail(id, user);
  }

  // ======================== TRUCK DOCUMENTS ================================

  @Get(':id/documents')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar documentos del camión' })
  @ApiQuery({ name: 'linkedTo', required: false, description: 'expense|income|freight|movement|none' })
  @ApiQuery({ name: 'type', required: false })
  listDocuments(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('linkedTo') linkedTo?: string, @Query('type') docType?: string) {
    return this.service.listDocuments(id, user, linkedTo, docType);
  }

  @Post(':id/documents')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Agregar documento al camión' })
  addDocument(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.addDocument(id, user, body);
  }

  @Patch(':id/documents/:docId')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Actualizar documento del camión' })
  updateDocument(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.updateDocument(id, docId, user, body);
  }

  @Patch(':id/documents/:docId/delete')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Eliminar documento del camión' })
  deleteDocument(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @CurrentUser() user: any) {
    return this.service.deleteDocument(id, docId, user);
  }

  // ======================== TRUCK EXPENSES =================================

  @Get(':id/expenses')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar gastos del camión' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  listExpenses(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.listExpenses(id, user, from, to);
  }

  @Post(':id/expenses')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar gasto del camión' })
  addExpense(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.addExpense(id, user, body);
  }

  @Patch(':id/expenses/:expenseId')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Editar gasto del camión' })
  updateExpense(@Param('id', ParseUUIDPipe) id: string, @Param('expenseId', ParseUUIDPipe) expenseId: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.updateExpense(id, expenseId, user, body);
  }

  @Patch(':id/expenses/:expenseId/delete')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Eliminar gasto del camión' })
  deleteExpense(@Param('id', ParseUUIDPipe) id: string, @Param('expenseId', ParseUUIDPipe) expenseId: string, @CurrentUser() user: any) {
    return this.service.deleteExpense(id, expenseId, user);
  }

  @Get(':id/expenses/summary')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Resumen de gastos del camión' })
  getExpenseSummary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getExpenseSummary(id, user);
  }

  // ======================== TRUCK FREIGHT HISTORY ===========================

  @Get(':id/freights')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Historial de fletes del camión' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getFreightHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    return this.service.getFreightHistory(id, user, take ? parseInt(take, 10) : 20, skip ? parseInt(skip, 10) : 0);
  }

  // ======================== TRUCK INCOMES ==================================

  @Get(':id/incomes')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar ingresos del camión' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'status', required: false })
  listIncomes(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string) {
    return this.service.listIncomes(id, user, from, to, status);
  }

  @Post(':id/incomes')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar ingreso del camión' })
  addIncome(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.addIncome(id, user, body);
  }

  @Patch(':id/incomes/:incomeId')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Editar ingreso' })
  updateIncome(@Param('id', ParseUUIDPipe) id: string, @Param('incomeId', ParseUUIDPipe) incomeId: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.updateIncome(id, incomeId, user, body);
  }

  @Patch(':id/incomes/:incomeId/delete')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Eliminar ingreso' })
  deleteIncome(@Param('id', ParseUUIDPipe) id: string, @Param('incomeId', ParseUUIDPipe) incomeId: string, @CurrentUser() user: any) {
    return this.service.deleteIncome(id, incomeId, user);
  }

  @Get(':id/incomes/summary')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Resumen de ingresos' })
  getIncomeSummary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getIncomeSummary(id, user);
  }

  // ======================== TRUCK MOVEMENTS ================================

  @Get(':id/movements')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar movimientos extra-flete' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'type', required: false })
  listMovements(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('from') from?: string, @Query('to') to?: string, @Query('type') type?: string) {
    return this.service.listMovements(id, user, from, to, type);
  }

  @Post(':id/movements')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar movimiento extra-flete' })
  addMovement(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.addMovement(id, user, body);
  }

  @Patch(':id/movements/:movId')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Editar movimiento' })
  updateMovement(@Param('id', ParseUUIDPipe) id: string, @Param('movId', ParseUUIDPipe) movId: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.updateMovement(id, movId, user, body);
  }

  @Patch(':id/movements/:movId/delete')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Eliminar movimiento' })
  deleteMovement(@Param('id', ParseUUIDPipe) id: string, @Param('movId', ParseUUIDPipe) movId: string, @CurrentUser() user: any) {
    return this.service.deleteMovement(id, movId, user);
  }

  // ======================== TRIP DATA ======================================

  @Patch(':freightId/assignments/:assignmentId/trip-data')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar datos de viaje (km, combustible, odómetro)' })
  updateTripData(@Param('freightId', ParseUUIDPipe) freightId: string, @Param('assignmentId', ParseUUIDPipe) assignmentId: string, @CurrentUser() user: any, @Body() body: any) {
    return this.service.updateTripData(freightId, assignmentId, user, body);
  }

  // ======================== ECONOMIC SUMMARY ===============================

  @Get(':id/economic-summary')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Resumen económico del camión' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  getEconomicSummary(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getEconomicSummary(id, user, from, to);
  }

  // ======================== DOCUMENT OCR ===================================

  @Post(':id/documents/:docId/ocr')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Procesar documento con OCR/IA' })
  processDocOcr(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @CurrentUser() user: any) {
    return this.service.processDocOcr(id, docId, user);
  }

  @Get(':id/documents/:docId/ocr')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Obtener resultado de OCR' })
  getDocOcr(@Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @CurrentUser() user: any) {
    return this.service.getDocOcr(id, docId, user);
  }
}
