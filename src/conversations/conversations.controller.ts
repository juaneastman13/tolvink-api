// =====================================================================
// TOLVINK — Conversations Controller + Service v3
// Independent chat + freight chat with search + company name search
// =====================================================================

import { Controller, Get, Post, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs =======================================

export class StartConversationDto {
  @ApiProperty({ description: 'ID de empresa destino' })
  @IsUUID()
  targetCompanyId: string;
}

export class SendMessageDto {
  @ApiProperty({ description: 'Texto del mensaje', maxLength: 2000 })
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class ConversationsService {
  constructor(private prisma: PrismaService) {}

  private async resolveAllCompanyIds(user: any): Promise<string[]> {
    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { companyId: true, companyByType: true },
    });
    if (dbUser?.companyId) ids.add(dbUser.companyId);
    const cbt = (dbUser?.companyByType as any) || {};
    Object.values(cbt).forEach((v: any) => { if (v) ids.add(v); });
    return Array.from(ids);
  }

  async searchCompanies(q: string, user: any) {
    if (!q || q.trim().length < 2) return [];
    const allIds = await this.resolveAllCompanyIds(user);
    return this.prisma.company.findMany({
      where: {
        active: true,
        id: { notIn: allIds },
        name: { contains: q.trim(), mode: 'insensitive' },
      },
      select: { id: true, name: true, type: true },
      take: 10,
      orderBy: { name: 'asc' },
    });
  }

  async searchUsers(q: string, user: any) {
    if (!q || q.trim().length < 2) return [];
    return this.prisma.user.findMany({
      where: {
        active: true,
        id: { not: user.sub },
        name: { contains: q.trim(), mode: 'insensitive' },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        company: { select: { id: true, name: true, type: true } },
      },
      take: 10,
      orderBy: { name: 'asc' },
    });
  }

  async startConversation(dto: StartConversationDto, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);
    const myPrimaryId = allIds[0];
    const targetId = dto.targetCompanyId;

    if (allIds.includes(targetId)) {
      throw new BadRequestException('No podés iniciar conversación con tu propia empresa');
    }

    const target = await this.prisma.company.findFirst({
      where: { id: targetId, active: true },
    });
    if (!target) throw new BadRequestException('Empresa no encontrada');

    // Check if conversation already exists between any of user's companies and target
    const existing = await this.prisma.conversation.findFirst({
      where: {
        freightId: null,
        AND: [
          { participants: { some: { companyId: { in: allIds } } } },
          { participants: { some: { companyId: targetId } } },
        ],
      },
      include: { participants: true },
    });

    if (existing && existing.participants.length === 2) {
      return existing;
    }

    return this.prisma.conversation.create({
      data: {
        participants: {
          create: [
            { companyId: myPrimaryId },
            { companyId: targetId },
          ],
        },
      },
      include: { participants: true },
    });
  }

  async listConversations(user: any, search?: string) {
    const allIds = await this.resolveAllCompanyIds(user);

    const convs = await this.prisma.conversation.findMany({
      where: {
        participants: { some: { companyId: { in: allIds } } },
      },
      include: {
        participants: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: { id: true, name: true } } },
        },
        freight: { select: { id: true, code: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Enrich participants with company info
    const companyIds = new Set<string>();
    convs.forEach(c => c.participants.forEach(p => companyIds.add(p.companyId)));

    const companies = await this.prisma.company.findMany({
      where: { id: { in: Array.from(companyIds) } },
      select: { id: true, name: true, type: true },
    });
    const companyMap = new Map(companies.map(c => [c.id, c]));

    const enriched = convs.map(c => {
      const participantsWithCompany = c.participants.map(p => ({
        ...p,
        company: companyMap.get(p.companyId) || null,
      }));

      const otherParticipants = participantsWithCompany.filter(p => !allIds.includes(p.companyId));
      const displayName = c.freight
        ? `Flete ${c.freight.code}`
        : otherParticipants.map(p => p.company?.name || 'Desconocido').join(', ');

      return { ...c, participants: participantsWithCompany, displayName };
    });

    if (search && search.trim()) {
      const s = search.toLowerCase().trim();
      return enriched.filter(c =>
        c.displayName.toLowerCase().includes(s) ||
        c.participants.some(p => p.company?.name?.toLowerCase().includes(s)) ||
        c.freight?.code?.toLowerCase().includes(s)
      );
    }

    return enriched;
  }

  async getMessages(conversationId: string, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);

    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: { in: allIds } },
    });

    if (!participant) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { freight: true },
      });
      if (conv?.freight) {
        const isInvolved =
          allIds.includes(conv.freight.originCompanyId) ||
          (conv.freight.destCompanyId && allIds.includes(conv.freight.destCompanyId));

        if (isInvolved) {
          await this.prisma.conversationParticipant.create({
            data: { conversationId, companyId: allIds[0] },
          }).catch(() => {});
        } else {
          const assignment = await this.prisma.freightAssignment.findFirst({
            where: {
              freightId: conv.freight.id,
              transportCompanyId: { in: allIds },
              status: { in: ['active', 'accepted'] },
            },
          });
          if (assignment) {
            await this.prisma.conversationParticipant.create({
              data: { conversationId, companyId: allIds[0] },
            }).catch(() => {});
          } else {
            throw new ForbiddenException('No participás en esta conversación');
          }
        }
      } else {
        throw new ForbiddenException('No participás en esta conversación');
      }
    }

    return this.prisma.message.findMany({
      where: { conversationId },
      include: { sender: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sendMessage(conversationId: string, dto: SendMessageDto, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);

    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: { in: allIds } },
    });

    if (!participant) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { freight: true },
      });
      if (conv?.freight) {
        const isInvolved =
          allIds.includes(conv.freight.originCompanyId) ||
          (conv.freight.destCompanyId && allIds.includes(conv.freight.destCompanyId));

        const isTransporter = await this.prisma.freightAssignment.findFirst({
          where: {
            freightId: conv.freight.id,
            transportCompanyId: { in: allIds },
            status: { in: ['active', 'accepted'] },
          },
        });

        if (isInvolved || isTransporter) {
          await this.prisma.conversationParticipant.create({
            data: { conversationId, companyId: allIds[0] },
          }).catch(() => {});
        } else {
          throw new ForbiddenException('No participás en esta conversación');
        }
      } else {
        throw new ForbiddenException('No participás en esta conversación');
      }
    }

    return this.prisma.message.create({
      data: {
        conversationId,
        senderId: user.sub,
        text: dto.text,
      },
      include: { sender: { select: { id: true, name: true } } },
    });
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(private service: ConversationsService) {}

  @Get('search-companies')
  @ApiOperation({ summary: 'Buscar empresas por nombre para iniciar chat' })
  @ApiQuery({ name: 'q', required: true })
  searchCompanies(@Query('q') q: string, @CurrentUser() user: any) {
    return this.service.searchCompanies(q, user);
  }

  @Get('search-users')
  @ApiOperation({ summary: 'Buscar usuarios por nombre para iniciar chat' })
  @ApiQuery({ name: 'q', required: true })
  searchUsers(@Query('q') q: string, @CurrentUser() user: any) {
    return this.service.searchUsers(q, user);
  }

  @Post('start')
  @ApiOperation({ summary: 'Iniciar conversación con otra empresa' })
  start(@Body() dto: StartConversationDto, @CurrentUser() user: any) {
    return this.service.startConversation(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Listar conversaciones' })
  @ApiQuery({ name: 'search', required: false })
  list(@CurrentUser() user: any, @Query('search') search?: string) {
    return this.service.listConversations(user, search);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Obtener mensajes de conversación' })
  messages(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.getMessages(id, user);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Enviar mensaje' })
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: any,
  ) {
    return this.service.sendMessage(id, dto, user);
  }
}
