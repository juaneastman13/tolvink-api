import {
  Controller, Get, Post, Patch, Param, Body,
  UseGuards, Injectable, NotFoundException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsIn, IsArray } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { PartsLookupService } from './parts-lookup.service';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_LOOPS = 3;

const TOOLS: any[] = [
  {
    name: 'search_parts',
    description: 'Busca números de pieza verificados en catálogos oficiales de fabricantes (John Deere, Case IH, New Holland, etc). Usa SIEMPRE esta herramienta antes de mencionar cualquier repuesto. NUNCA inventes un número de pieza.',
    input_schema: {
      type: 'object',
      properties: {
        machine_brand: { type: 'string', description: 'Marca de la máquina' },
        machine_model: { type: 'string', description: 'Modelo de la máquina' },
        part_description: { type: 'string', description: 'Descripción de la pieza en inglés. Ej: engine oil filter' },
        part_category: { type: 'string', enum: ['engine','transmission','hydraulics','electrical','filters','cooling','fuel','brakes','steering','cab','pto','other'] },
      },
      required: ['machine_brand', 'machine_model', 'part_description'],
    },
  },
  {
    name: 'verify_part_number',
    description: 'Verifica si un número de pieza existe buscando en catálogos oficiales.',
    input_schema: {
      type: 'object',
      properties: { part_number: { type: 'string', description: 'Número de pieza a verificar' } },
      required: ['part_number'],
    },
  },
];

// ── DTOs ──────────────────────────────────────────────────────────────

class SendMessageDto {
  @IsString() @IsNotEmpty() content: string;
  @IsOptional() @IsArray() mediaUrls?: string[];
  @IsOptional() @IsArray() mediaTypes?: string[];
}

class ResolveSessionDto {
  @IsString() @IsIn(['resolved', 'unresolved']) status: string;
  @IsOptional() @IsString() resolutionNotes?: string;
}

// ── Service ──────────���────────────────────────────────────────────────

@Injectable()
export class DiagnosticService {
  private readonly logger = new Logger('DiagnosticService');
  private client: Anthropic | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private partsLookup: PartsLookupService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('Mechanic diagnostic agent enabled');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — diagnostic agent disabled');
    }
  }

  private async validateMachine(machineId: string, companyId: string) {
    const m = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) throw new NotFoundException('Máquina no encontrada');
  }

  // ── Sessions ──

  async createSession(machineId: string, companyId: string, userId: string) {
    await this.validateMachine(machineId, companyId);
    return this.prisma.diagnosticSession.create({
      data: { machineId, companyId, userId, messages: [] },
    });
  }

  async listSessions(machineId: string, companyId: string) {
    await this.validateMachine(machineId, companyId);
    const sessions = await this.prisma.diagnosticSession.findMany({
      where: { machineId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, messages: true },
    });
    return sessions.map(s => ({
      ...s,
      messagesCount: Array.isArray(s.messages) ? (s.messages as any[]).length : 0,
      messages: undefined,
    }));
  }

  async getSession(id: string, companyId: string) {
    const s = await this.prisma.diagnosticSession.findUnique({
      where: { id },
      include: { machine: { select: { id: true, brand: true, model: true, machineType: true, year: true } } },
    });
    if (!s || s.companyId !== companyId) throw new NotFoundException('Sesión no encontrada');
    return s;
  }

  // ── Messages ──

  async sendMessage(sessionId: string, companyId: string, dto: SendMessageDto) {
    const session = await this.prisma.diagnosticSession.findUnique({
      where: { id: sessionId },
      include: {
        machine: {
          include: {
            template: true,
            modifications: { orderBy: { date: 'desc' } },
            maintenanceRecords: { orderBy: { date: 'desc' }, take: 10 },
          },
        },
      },
    });
    if (!session || session.companyId !== companyId) throw new NotFoundException('Sesión no encontrada');

    const messages = (session.messages as any[]) || [];

    // Add user message
    const userMsg: any = {
      id: randomUUID(), role: 'user', content: dto.content,
      mediaUrls: dto.mediaUrls || [], mediaTypes: dto.mediaTypes || [],
      timestamp: new Date().toISOString(),
    };
    messages.push(userMsg);

    // Build assistant response
    let assistantContent: { text: string; parts: any[] } = { text: 'El agente de diagnóstico no está disponible en este momento. Intentá de nuevo más tarde.', parts: [] };

    if (this.client) {
      try {
        assistantContent = await this.callClaude(session.machine, messages, dto.mediaUrls);
      } catch (err) {
        this.logger.error(`Claude error: ${err.message}`);
        assistantContent = { text: 'Hubo un error al procesar tu consulta. Por favor intentá de nuevo.', parts: [] };
      }
    }

    const assistantMsg: any = {
      id: randomUUID(), role: 'assistant', content: assistantContent.text,
      mediaUrls: [], mediaTypes: [], timestamp: new Date().toISOString(),
      suggestedParts: assistantContent.parts?.length > 0 ? assistantContent.parts : undefined,
    };
    messages.push(assistantMsg);

    // Auto-generate title on first exchange
    const title = session.title || this.generateTitle(dto.content);

    await this.prisma.diagnosticSession.update({
      where: { id: sessionId },
      data: { messages, title },
    });

    return assistantMsg;
  }

  private async callClaude(machine: any, messages: any[], mediaUrls?: string[]): Promise<{ text: string; parts: any[] }> {
    const systemPrompt = this.buildSystemPrompt(machine);
    const claudeMessages = this.buildClaudeMessages(messages, mediaUrls);
    const collectedParts: any[] = [];

    let currentMessages = [...claudeMessages];

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const response = await this.client.messages.create({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: currentMessages,
        tools: TOOLS,
      });

      // If no tool use, extract text and return
      if (response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined;
        return { text: textBlock?.text || 'No pude generar una respuesta.', parts: collectedParts };
      }

      // Process tool calls
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults: any[] = [];

      for (const block of toolUseBlocks) {
        const tu = block as any;
        let result: any;
        try {
          if (tu.name === 'search_parts') {
            const parts = await this.partsLookup.searchParts({
              machineBrand: tu.input.machine_brand,
              machineModel: tu.input.machine_model,
              partDescription: tu.input.part_description,
              partCategory: tu.input.part_category,
            });
            collectedParts.push(...parts);
            result = parts.length > 0 ? parts : { found: false, message: 'No se encontraron resultados verificados para esta pieza.' };
          } else if (tu.name === 'verify_part_number') {
            const part = await this.partsLookup.verifyPartNumber(tu.input.part_number);
            if (part) collectedParts.push(part);
            result = part || { found: false, message: `No se pudo verificar el número de pieza ${tu.input.part_number}.` };
          } else {
            result = { error: `Tool ${tu.name} not found` };
          }
        } catch (err) {
          this.logger.error(`Tool ${tu.name} error: ${err.message}`);
          result = { error: 'Error al buscar repuestos. Intentá de nuevo.' };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }

      // Add assistant response + tool results for next loop
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    // If we exhausted loops, return last text
    return { text: 'No pude completar la búsqueda de repuestos. Intentá de nuevo.', parts: collectedParts };
  }

  private buildSystemPrompt(machine: any): string {
    const m = machine;
    const mods = m.modifications?.map((mod: any) => `- ${mod.description} (${mod.date ? new Date(mod.date).toLocaleDateString('es-UY') : 'sin fecha'})`).join('\n') || 'Ninguna';
    const maintenance = m.maintenanceRecords?.map((r: any) =>
      `- ${r.type}: ${r.description} (${new Date(r.date).toLocaleDateString('es-UY')}${r.horometerReading ? `, ${r.horometerReading} hs` : ''})`
    ).join('\n') || 'Sin registros';

    return `Sos un mecánico especialista en maquinaria agrícola con amplia experiencia en tractores, cosechadoras, sembradoras, enfardadoras e implementos de las principales marcas (John Deere, Case IH, New Holland, Massey Ferguson, Valtra, Claas).

Tu objetivo es diagnosticar problemas y proponer soluciones concretas y accionables.

## Máquina en consulta
- Marca: ${m.brand}
- Modelo: ${m.model}
- Tipo: ${m.machineType}
- Año: ${m.year || 'No especificado'}
- Motor: ${m.engineBrand || ''} ${m.engineModel || ''} ${m.enginePower || ''} ${m.engineDisplacement || ''}
- Transmisión: ${m.transmissionType || 'No especificada'}
- Combustible: ${m.fuelType || 'No especificado'}
- Horómetro actual: ${m.currentHorometer != null ? `${m.currentHorometer} hs` : 'No registrado'}

## Modificaciones realizadas
${mods}

## Historial de mantenimiento reciente
${maintenance}

## Instrucciones de respuesta

1. Cuando el usuario describe un problema o envía una imagen:
   - Identificá las posibles causas ordenadas por probabilidad.
   - Explicá cada causa de forma técnica pero accesible.
   - Considerá el historial de la máquina y sus modificaciones.

2. Para cada causa posible, proponé pasos concretos de solución:
   - Verificaciones que puede hacer el operador en campo.
   - Reparaciones necesarias con nivel de dificultad.
   - Si requiere taller, indicarlo.

3. Cuando la solución requiere un repuesto:
   - Llamá SIEMPRE a la herramienta search_parts con marca, modelo y descripción de la pieza.
   - Presentá SOLO los resultados que la herramienta devuelva con la fuente.
   - Si la herramienta no encuentra resultados, decí: "No pude verificar el número de pieza. Te recomiendo consultar con tu concesionario o en el catálogo del fabricante."
   - NUNCA inventes un número de pieza de tu memoria. Los números que "recordás" pueden no existir.
   - Si hay cross-references (alternativas compatibles), mencioná la marca.

4. Si recibís una imagen:
   - Analizá lo que se ve: componentes, estado, daños visibles, códigos de error en pantalla.
   - Si es un código de error, explicá qué significa y cómo resolverlo.

5. Tono: profesional pero cercano, como un mecánico experimentado hablándole a un colega. Español rioplatense.

6. Si no tenés suficiente información para diagnosticar, pedí más datos específicos.`;
  }

  private buildClaudeMessages(messages: any[], mediaUrls?: string[]): any[] {
    return messages.map((msg: any) => {
      if (msg.role === 'assistant') {
        return { role: 'assistant', content: msg.content };
      }
      // User message - may include images
      const content: any[] = [];
      if (msg.mediaUrls?.length > 0) {
        for (let i = 0; i < msg.mediaUrls.length; i++) {
          const url = msg.mediaUrls[i];
          const type = msg.mediaTypes?.[i] || 'image';
          if (type === 'image') {
            content.push({ type: 'image', source: { type: 'url', url } });
          }
        }
      }
      content.push({ type: 'text', text: msg.content });
      return { role: 'user', content };
    });
  }

  private generateTitle(firstMessage: string): string {
    const clean = firstMessage.replace(/\n/g, ' ').trim();
    if (clean.length <= 60) return clean;
    return clean.slice(0, 57) + '...';
  }

  // ── Resolve ──

  async resolveSession(id: string, companyId: string, status: string, notes?: string) {
    const s = await this.prisma.diagnosticSession.findUnique({ where: { id }, select: { companyId: true } });
    if (!s || s.companyId !== companyId) throw new NotFoundException('Sesión no encontrada');
    return this.prisma.diagnosticSession.update({
      where: { id },
      data: { status, resolutionNotes: notes },
    });
  }

  // ── Share ──

  async shareSession(id: string, companyId: string) {
    const s = await this.prisma.diagnosticSession.findUnique({ where: { id }, select: { companyId: true } });
    if (!s || s.companyId !== companyId) throw new NotFoundException('Sesión no encontrada');
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours
    await this.prisma.diagnosticSession.update({
      where: { id },
      data: { shareToken: token, shareExpiresAt: expiresAt },
    });
    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    return { shareUrl: `${frontendUrl}/public/diagnostic/${token}`, expiresAt };
  }

  // ── Public ─���

  async getPublicSession(shareToken: string) {
    const s = await this.prisma.diagnosticSession.findUnique({
      where: { shareToken },
      include: { machine: { select: { brand: true, model: true, machineType: true, year: true, engineBrand: true, engineModel: true, enginePower: true } } },
    });
    if (!s) throw new NotFoundException('Enlace no encontrado');
    if (s.shareExpiresAt && new Date() > s.shareExpiresAt) {
      throw new NotFoundException('Este enlace ha expirado');
    }
    // Return limited data — no company or user info
    return {
      title: s.title, status: s.status, messages: s.messages,
      machine: s.machine, createdAt: s.createdAt,
    };
  }
}

// ── Controller (auth required) ───────��────────────────────────────────

@ApiTags('Diagnostics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DiagnosticController {
  constructor(private svc: DiagnosticService) {}
  private cid(u: any) { return u.activeCompanyId || u.companyId; }

  @Post('machines/:machineId/diagnostic-sessions')
  create(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.createSession(machineId, this.cid(user), user.sub);
  }

  @Get('machines/:machineId/diagnostic-sessions')
  list(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.listSessions(machineId, this.cid(user));
  }

  @Get('diagnostic-sessions/:id')
  get(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.getSession(id, this.cid(user));
  }

  @Post('diagnostic-sessions/:id/message')
  sendMessage(@Param('id') id: string, @Body() dto: SendMessageDto, @CurrentUser() user: any) {
    return this.svc.sendMessage(id, this.cid(user), dto);
  }

  @Patch('diagnostic-sessions/:id/resolve')
  resolve(@Param('id') id: string, @Body() dto: ResolveSessionDto, @CurrentUser() user: any) {
    return this.svc.resolveSession(id, this.cid(user), dto.status, dto.resolutionNotes);
  }

  @Post('diagnostic-sessions/:id/share')
  share(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.shareSession(id, this.cid(user));
  }
}

// ── Public Controller (no auth) ───────────────────────────────────────

@ApiTags('Diagnostics Public')
@Controller('public/diagnostic-sessions')
export class DiagnosticPublicController {
  constructor(private svc: DiagnosticService) {}

  @Get(':shareToken')
  get(@Param('shareToken') shareToken: string) {
    return this.svc.getPublicSession(shareToken);
  }
}
