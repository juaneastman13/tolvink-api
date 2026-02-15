// =====================================================================
// TOLVINK — Conversations Controller + Service
// Independent chat (not tied to freight)
// =====================================================================

import { Controller, Get, Post, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty, MaxLength } from 'class-validator';
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

    // Validate target company exists and is active
    const target = await this.prisma.company.findFirst({
      where: { id: targetId, active: true },
    });
    if (!target) throw new BadRequestException('Empresa no encontrada');

    // Only allow chat with plants or transporters (not producer-to-producer)
    const allowedPairs = ['plant', 'transporter'];
    if (user.companyType === 'producer' && !allowedPairs.includes(target.type)) {
      throw new BadRequestException('Solo podés chatear con plantas o transportistas');
    }

    // Check if conversation already exists between these two companies
    const existing = await this.prisma.conversation.findFirst({
      where: {
        freightId: null, // Independent conversations only
        participants: {
          every: {
            companyId: { in: [myCompanyId, targetId] },
          },
        },
        AND: [
          { participants: { some: { companyId: myCompanyId } } },
          { participants: { some: { companyId: targetId } } },
        ],
      },
      include: {
        participants: true,
      },
    });

    // Only reuse if it's exactly a 2-person conversation between these two companies
    if (existing && existing.participants.length === 2) {
      return existing;
    }

    // Create new conversation with participants
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

  async listConversations(user: any) {
    return this.prisma.conversation.findMany({
      where: {
        participants: { some: { companyId: user.companyId } },
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
  }

  async getMessages(conversationId: string, user: any) {
    // Verify user's company is participant
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: user.companyId },
    });
    if (!participant) throw new ForbiddenException('No participás en esta conversación');

    return this.prisma.message.findMany({
      where: { conversationId },
      include: { sender: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sendMessage(conversationId: string, dto: SendMessageDto, user: any) {
    // Verify user's company is participant
    const participant = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId, companyId: user.companyId },
    });
    if (!participant) throw new ForbiddenException('No participás en esta conversación');

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
  list(@CurrentUser() user: any) {
    return this.service.listConversations(user);
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
