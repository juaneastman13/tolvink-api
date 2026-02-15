// =====================================================================
// TOLVINK — Conversations Controller + Service v2
// Independent chat + freight chat with search
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

  async startConversation(dto: StartConversationDto, user: any) {
    const myCompanyId = user.companyId;
    const targetId = dto.targetCompanyId;

    if (myCompanyId === targetId) {
      throw new BadRequestException('No podés iniciar conversación con tu propia empresa');
    }

    const target = await this.prisma.company.findFirst({
      where: { id: targetId, active: true },
    });
    if (!target) throw new BadRequestException('Empresa no encontrada');

    // Check if conversation already exists between these two companies
    const existing = await this.prisma.conversation.findFirst({
      where: {
        freightId: null,
        AND: [
          { participants: { some: { companyId: myCompanyId } } },
          { participants: { some: { companyId: targetId } } },
        ],
      },
      include: {
        participants: {
          include: { conversation: false },
        },
      },
    });

    if (existing && existing.participants.length === 2) {
      return existing;
    }

    return this.prisma.conversation.create({
      data: {
        participants: {
          create: [
            { companyId: myCompanyId },
            { companyId: targetId },
          ],
        },
      },
      include: {
        participants: true,
      },
    });
  }

  async listConversations(user: any, search?: string) {
    const where: any = {
      participants: { some: { companyId: user.companyId } },
    };

    const convs = await this.prisma.conversation.findMany({
      where,
      include: {
        participants: {
          include: {
            // We need company name for display
          },
        },
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

    // Build enriched response
    const enriched = convs.map(c => {
      const participantsWithCompany = c.participants.map(p => ({
        ...p,
        company: companyMap.get(p.companyId) || null,
      }));

      // Build display name
      const otherParticipants = participantsWithCompany.filter(p => p.companyId !== user.companyId);
      const displayName = c.freight
        ? `Flete ${c.freight.code}`
        : otherParticipants.map(p => p.company?.name || 'Desconocido').join(', ');

      return {
        ...c,
        participants: participantsWithCompany,
        displayName,
      };
    });

    // Apply search filter if provided
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
    // Verify user's company is participant
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: user.companyId },
    });

    // Fallback: check if it's a freight conversation where user's company is involved
    if (!participant) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { freight: true },
      });
      if (conv?.freight) {
        const isInvolved =
          conv.freight.originCompanyId === user.companyId ||
          conv.freight.destCompanyId === user.companyId;

        if (isInvolved) {
          // Auto-add as participant
          await this.prisma.conversationParticipant.create({
            data: { conversationId, companyId: user.companyId },
          }).catch(() => {}); // ignore if already exists
        } else {
          // Check if transporter
          const assignment = await this.prisma.freightAssignment.findFirst({
            where: {
              freightId: conv.freight.id,
              transportCompanyId: user.companyId,
              status: { in: ['active', 'accepted'] },
            },
          });
          if (assignment) {
            await this.prisma.conversationParticipant.create({
              data: { conversationId, companyId: user.companyId },
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
    // Verify access (same logic as getMessages)
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: user.companyId },
    });

    if (!participant) {
      // Try auto-join for freight conversations
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { freight: true },
      });
      if (conv?.freight) {
        const isInvolved =
          conv.freight.originCompanyId === user.companyId ||
          conv.freight.destCompanyId === user.companyId;

        const isTransporter = await this.prisma.freightAssignment.findFirst({
          where: {
            freightId: conv.freight.id,
            transportCompanyId: user.companyId,
            status: { in: ['active', 'accepted'] },
          },
        });

        if (isInvolved || isTransporter) {
          await this.prisma.conversationParticipant.create({
            data: { conversationId, companyId: user.companyId },
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
