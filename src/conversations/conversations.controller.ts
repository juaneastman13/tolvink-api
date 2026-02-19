// =====================================================================
// TOLVINK — Conversations Controller + Service v5
// User-level tracking, mark-read, freight visibility for all parties
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe, HttpCode } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { SseService } from '../sse/sse.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs =======================================

export class StartConversationDto {
  @ApiProperty({ description: 'ID de usuario destino' })
  @IsUUID()
  targetUserId: string;
}

export class SendMessageDto {
  @ApiProperty({ description: 'Texto del mensaje', maxLength: 2000 })
  @IsNotEmpty()
  @MaxLength(2000)
  text: string;
}

// ======================== SERVICE ====================================

// In-memory cache for conversation participants (TTL 5min)
interface ParticipantsCache {
  companyIds: string[];
  timestamp: number;
}
const participantsCache = new Map<string, ParticipantsCache>();
const PARTICIPANTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup: evict stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of participantsCache) {
    if (now - entry.timestamp > PARTICIPANTS_CACHE_TTL_MS) participantsCache.delete(key);
  }
}, PARTICIPANTS_CACHE_TTL_MS);

@Injectable()
export class ConversationsService {
  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
    private sse: SseService,
  ) {}

  private async resolveAllCompanyIds(user: any): Promise<string[]> {
    return this.companyRes.resolveAllCompanyIds(user);
  }

  /** Get conversation participants with 5min cache */
  private async getConversationCompanyIds(conversationId: string): Promise<string[]> {
    const cached = participantsCache.get(conversationId);
    if (cached && Date.now() - cached.timestamp < PARTICIPANTS_CACHE_TTL_MS) {
      return cached.companyIds;
    }

    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { companyId: true },
    });

    const companyIds = participants.map(p => p.companyId);
    participantsCache.set(conversationId, { companyIds, timestamp: Date.now() });

    return companyIds;
  }

  /** Invalidate participants cache for a conversation */
  private invalidateParticipantsCache(conversationId: string) {
    participantsCache.delete(conversationId);
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
    const targetUserId = dto.targetUserId;

    if (targetUserId === user.sub) {
      throw new BadRequestException('No podés iniciar conversación con vos mismo');
    }

    // Resolve target user and their company
    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, companyId: true },
    });
    if (!targetUser) throw new BadRequestException('Usuario no encontrado');

    const allIds = await this.resolveAllCompanyIds(user);
    const myPrimaryId = allIds[0];
    const targetCompanyId = targetUser.companyId;

    // Check existing conversation between these two users (not freight-related)
    const existing = await this.prisma.conversation.findFirst({
      where: {
        freightId: null,
        AND: [
          { participants: { some: { userId: user.sub } } },
          { participants: { some: { userId: targetUserId } } },
        ],
      },
      include: { participants: true },
    });
    if (existing) return existing;

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

  async listConversations(user: any, search?: string, skip?: number, take?: number) {
    const allIds = await this.resolveAllCompanyIds(user);

    const takeNum = Math.min(take || 50, 100); // Max 100 conversations per request
    const skipNum = skip || 0;

    // Find conversations where user is participant OR involved in freight
    const convs = await this.prisma.conversation.findMany({
      where: {
        OR: [
          { participants: { some: { companyId: { in: allIds } } } },
          { freight: { originCompanyId: { in: allIds } } },
          { freight: { destCompanyId: { in: allIds } } },
          {
            freight: {
              assignments: {
                some: {
                  transportCompanyId: { in: allIds },
                  status: { in: ['active', 'accepted'] },
                },
              },
            },
          },
        ],
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
      skip: skipNum,
      take: takeNum,
    });

    // Batch auto-add user as participant to freight conversations they can see
    const toAdd = convs.filter(c => c.freight && !c.participants.some(p => allIds.includes(p.companyId)));
    if (toAdd.length > 0) {
      await (this.prisma as any).conversationParticipant.createMany({
        data: toAdd.map(c => ({ conversationId: c.id, companyId: allIds[0], userId: user.sub })),
        skipDuplicates: true,
      }).catch(() => {});
      for (const c of toAdd) {
        c.participants.push({ id: 'auto', conversationId: c.id, companyId: allIds[0], userId: user.sub, joinedAt: new Date(), lastReadAt: null } as any);
      }
    }

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

      const otherParticipants = participantsEnriched.filter(p => p.userId ? p.userId !== user.sub : !allIds.includes(p.companyId));
      const lastMsgSender = c.messages?.[0]?.sender;
      const displayName = c.freight
        ? `Flete ${c.freight.code}`
        : otherParticipants.map(p => p.user?.name || '').filter(Boolean).join(', ')
          || (lastMsgSender?.id !== user.sub ? lastMsgSender?.name : null)
          || otherParticipants.map(p => p.company?.name || '').filter(Boolean).join(', ')
          || 'Chat';

      // Compute unread: compare lastReadAt of my participant vs last message time
      const myParticipant = c.participants.find(p => allIds.includes(p.companyId));
      const lastMsg = c.messages?.[0];
      let unread = false;
      if (lastMsg && lastMsg.senderId !== user.sub) {
        const lastReadAt = myParticipant?.lastReadAt;
        if (!lastReadAt || new Date(lastMsg.createdAt) > new Date(lastReadAt)) {
          unread = true;
        }
      }

      // Include pin and marked-unread flags
      const pinnedAt = myParticipant?.pinnedAt || null;
      const markedUnread = myParticipant?.markedUnread || false;

      return { ...c, participants: participantsEnriched, displayName, unread, pinnedAt, markedUnread };
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

  async markRead(conversationId: string, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: { in: allIds } },
    });
    if (!participant) return { ok: true };

    await this.prisma.conversationParticipant.update({
      where: { id: participant.id },
      data: { lastReadAt: new Date() },
    });

    // SSE: notify other participants that this user read the conversation
    this.sse.broadcastRead(conversationId, user.sub).catch(() => {});

    return { ok: true };
  }

  async typing(conversationId: string, user: any) {
    await this.sse.broadcastTyping(conversationId, user.sub, user.name || 'Usuario');
    return { ok: true };
  }

  async pinConversation(conversationId: string, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: { in: allIds } },
    });
    if (!participant) throw new ForbiddenException('No participás en esta conversación');

    const newPinnedAt = participant.pinnedAt ? null : new Date();
    await this.prisma.conversationParticipant.update({
      where: { id: participant.id },
      data: { pinnedAt: newPinnedAt },
    });

    return { pinned: !!newPinnedAt };
  }

  async toggleMarkUnread(conversationId: string, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: { in: allIds } },
    });
    if (!participant) throw new ForbiddenException('No participás en esta conversación');

    const newMarkedUnread = !participant.markedUnread;
    await this.prisma.conversationParticipant.update({
      where: { id: participant.id },
      data: { markedUnread: newMarkedUnread },
    });

    return { markedUnread: newMarkedUnread };
  }

  async getMessages(conversationId: string, user: any, pagination?: { take?: number; before?: string }) {
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

    // Auto mark as read (only on first page load, not when loading older messages)
    if (participant && !pagination?.before) {
      await this.prisma.conversationParticipant.update({
        where: { id: participant.id },
        data: { lastReadAt: new Date() },
      }).catch(() => {});
    }

    const take = Math.min(pagination?.take || 50, 100);
    const where: any = { conversationId };

    // Cursor-based pagination: load messages older than `before`
    if (pagination?.before) {
      const cursorMsg = await this.prisma.message.findUnique({
        where: { id: pagination.before },
        select: { createdAt: true },
      });
      if (cursorMsg) {
        where.createdAt = { lt: cursorMsg.createdAt };
      }
    }

    const messages = await this.prisma.message.findMany({
      where,
      include: { sender: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });

    // Return in chronological order + hasMore flag
    return {
      messages: messages.reverse(),
      hasMore: messages.length === take,
    };
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

    // Create message (no transaction needed)
    const message = await this.prisma.message.create({
      data: { conversationId, senderId: user.sub, text: dto.text },
      include: { sender: { select: { id: true, name: true } } },
    });

    // Fire-and-forget: mark read (async, no await)
    if (participant) {
      this.prisma.conversationParticipant.update({
        where: { id: participant.id },
        data: { lastReadAt: new Date() },
      }).catch(() => {});
    }

    // SSE: notify conversation participants about new message
    this.sse.broadcastMessage(conversationId, user.sub).catch(() => {});

    return message;
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
  @ApiOperation({ summary: 'Iniciar conversación con usuario' })
  start(@Body() dto: StartConversationDto, @CurrentUser() user: any) {
    return this.service.startConversation(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'Listar conversaciones' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'skip', required: false, description: 'Offset for pagination' })
  @ApiQuery({ name: 'take', required: false, description: 'Limit for pagination (max 100)' })
  list(
    @CurrentUser() user: any,
    @Query('search') search?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.service.listConversations(
      user,
      search,
      skip ? parseInt(skip) || 0 : 0,
      take ? parseInt(take) || 50 : 50,
    );
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marcar conversación como leída' })
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.markRead(id, user);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Obtener mensajes de conversación (paginado)' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'before', required: false, description: 'Cursor: message ID to load messages before' })
  messages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Query('take') take?: string,
    @Query('before') before?: string,
  ) {
    return this.service.getMessages(id, user, {
      take: take ? Math.min(parseInt(take) || 50, 100) : 50,
      before: before || undefined,
    });
  }

  @Post(':id/typing')
  @HttpCode(204)
  @Throttle({ default: { ttl: 2000, limit: 1 } }) // 1 req per 2s per user
  @ApiOperation({ summary: 'Indicar que el usuario está escribiendo' })
  typing(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.typing(id, user);
  }

  @Patch(':id/pin')
  @ApiOperation({ summary: 'Fijar/desfijar conversación' })
  pinConversation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.pinConversation(id, user);
  }

  @Patch(':id/mark-unread')
  @ApiOperation({ summary: 'Marcar/desmarcar conversación como no leída' })
  toggleMarkUnread(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.toggleMarkUnread(id, user);
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
