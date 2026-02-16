// =====================================================================
// TOLVINK — Conversations Controller + Service v4
// Conversations tracked by user (not just company) for grouping
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

  @ApiProperty({ description: 'ID de usuario destino', required: false })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;
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

  async searchUsers(q: string, user: any) {
    if (!q || q.trim().length < 2) return [];
    return this.prisma.user.findMany({
      where: {
        active: true,
        id: { not: user.sub },
        OR: [
          { name: { contains: q.trim(), mode: 'insensitive' } },
          { email: { contains: q.trim(), mode: 'insensitive' } },
          { phone: { contains: q.trim() } },
        ],
      },
      select: {
        id: true,
        name: true,
        phone: true,
        company: { select: { id: true, name: true, type: true } },
      },
      take: 15,
      orderBy: { name: 'asc' },
    });
  }

  async startConversation(dto: StartConversationDto, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);
    const myPrimaryId = allIds[0];
    const targetCompanyId = dto.targetCompanyId;
    const targetUserId = dto.targetUserId || null;

    if (allIds.includes(targetCompanyId)) {
      throw new BadRequestException('No podés iniciar conversación con tu propia empresa');
    }

    const target = await this.prisma.company.findFirst({
      where: { id: targetCompanyId, active: true },
    });
    if (!target) throw new BadRequestException('Empresa no encontrada');

    // Check existing: if targetUserId provided, match by user; else by company
    if (targetUserId) {
      const existing = await this.prisma.conversation.findFirst({
        where: {
          freightId: null,
          AND: [
            { participants: { some: { companyId: { in: allIds }, userId: user.sub } } },
            { participants: { some: { companyId: targetCompanyId, userId: targetUserId } } },
          ],
        },
        include: { participants: true },
      });
      if (existing) return existing;
    } else {
      const existing = await this.prisma.conversation.findFirst({
        where: {
          freightId: null,
          AND: [
            { participants: { some: { companyId: { in: allIds } } } },
            { participants: { some: { companyId: targetCompanyId } } },
          ],
        },
        include: { participants: true },
      });
      if (existing && existing.participants.length === 2) return existing;
    }

    return this.prisma.conversation.create({
      data: {
        participants: {
          create: [
            { companyId: myPrimaryId, userId: user.sub },
            { companyId: targetCompanyId, userId: targetUserId },
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

    // Collect all company IDs and user IDs for enrichment
    const companyIds = new Set<string>();
    const userIds = new Set<string>();
    convs.forEach(c => c.participants.forEach(p => {
      companyIds.add(p.companyId);
      if (p.userId) userIds.add(p.userId);
    }));

    const [companies, users] = await Promise.all([
      this.prisma.company.findMany({
        where: { id: { in: Array.from(companyIds) } },
        select: { id: true, name: true, type: true },
      }),
      userIds.size > 0
        ? this.prisma.user.findMany({
            where: { id: { in: Array.from(userIds) } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const companyMap = new Map(companies.map(c => [c.id, c]));
    const userMap = new Map(users.map(u => [u.id, u]));

    const enriched = convs.map(c => {
      const participantsEnriched = c.participants.map(p => ({
        ...p,
        company: companyMap.get(p.companyId) || null,
        user: p.userId ? (userMap.get(p.userId) || null) : null,
      }));

      const otherParticipants = participantsEnriched.filter(p => !allIds.includes(p.companyId));
      const displayName = c.freight
        ? `Flete ${c.freight.code}`
        : otherParticipants.map(p => p.user?.name || p.company?.name || 'Desconocido').join(', ');

      return { ...c, participants: participantsEnriched, displayName };
    });

    if (search && search.trim()) {
      const s = search.toLowerCase().trim();
      return enriched.filter(c =>
        c.displayName.toLowerCase().includes(s) ||
        c.participants.some(p =>
          p.company?.name?.toLowerCase().includes(s) ||
          p.user?.name?.toLowerCase().includes(s)
        ) ||
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
            data: { conversationId, companyId: allIds[0], userId: user.sub },
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
              data: { conversationId, companyId: allIds[0], userId: user.sub },
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
            data: { conversationId, companyId: allIds[0], userId: user.sub },
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

  @Get('search-users')
  @ApiOperation({ summary: 'Buscar usuarios por nombre para iniciar chat' })
  @ApiQuery({ name: 'q', required: true })
  searchUsers(@Query('q') q: string, @CurrentUser() user: any) {
    return this.service.searchUsers(q, user);
  }

  @Post('start')
  @ApiOperation({ summary: 'Iniciar conversación con usuario/empresa' })
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
