import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, ParseUUIDPipe,
  Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger, Module,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsUUID } from 'class-validator';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { DatabaseModule } from '../database/database.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { nanoid } from 'nanoid';

// ======================== DTOs =======================================

class CreateSharedLinkDto {
  @ApiProperty({ enum: ['FREIGHT', 'PORTAL', 'TICKET'] })
  @IsEnum(['FREIGHT', 'PORTAL', 'TICKET'])
  linkType: string;

  @ApiProperty()
  @IsUUID()
  targetCompanyId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  freightId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  ticketId?: string;

  @ApiProperty({ required: false, enum: ['WEB', 'WHATSAPP'] })
  @IsOptional()
  @IsEnum(['WEB', 'WHATSAPP'])
  createdVia?: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class SharedLinksService {
  private readonly logger = new Logger(SharedLinksService.name);

  constructor(private prisma: PrismaService) {}

  async createLink(dto: CreateSharedLinkDto, user: any) {
    const creatorCompanyId = user.activeCompanyId || user.companyId;
    if (!creatorCompanyId) throw new BadRequestException('No se pudo determinar tu empresa');

    // Block CONSULTA (READONLY) users from creating shared links
    if (user.role !== 'platform_admin' && user.userType !== 'plant') {
      const readonlyAccess = await this.prisma.companyAccess.findFirst({
        where: {
          granteeCompanyId: creatorCompanyId,
          isActive: true,
          accessLevel: 'READONLY',
        },
      });
      if (readonlyAccess) {
        throw new ForbiddenException('Usuario CONSULTA no puede crear links compartidos');
      }
    }

    // Check for existing active link for same resource+target
    const existing = await this.prisma.sharedLink.findFirst({
      where: {
        creatorCompanyId,
        targetCompanyId: dto.targetCompanyId,
        linkType: dto.linkType as any,
        ...(dto.freightId ? { freightId: dto.freightId } : {}),
        ...(dto.ticketId ? { ticketId: dto.ticketId } : {}),
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
    });

    if (existing) {
      // Update last accessed and return existing
      return { ...existing, isReused: true };
    }

    // Create new link with TTL per type
    const TTL_MAP = { FREIGHT: 72 * 3600_000, PORTAL: 30 * 24 * 3600_000, TICKET: 7 * 24 * 3600_000 };
    const expiresAt = new Date(Date.now() + (TTL_MAP[dto.linkType] || 72 * 3600_000));

    const link = await this.prisma.sharedLink.create({
      data: {
        token: nanoid(21),
        linkType: dto.linkType as any,
        creatorCompanyId,
        targetCompanyId: dto.targetCompanyId,
        freightId: dto.freightId || null,
        ticketId: dto.ticketId || null,
        createdById: user.sub,
        createdVia: (dto.createdVia as any) || 'WEB',
        expiresAt,
      },
    });

    return { ...link, isReused: false };
  }

  async resolveToken(token: string) {
    const link = await this.prisma.sharedLink.findUnique({
      where: { token },
      include: {
        creatorCompany: { select: { id: true, name: true } },
        targetCompany: { select: { id: true, name: true } },
      },
    });

    if (!link) return { valid: false, reason: 'not_found' };
    if (link.revokedAt) {
      this.logger.warn(`Shared link access denied: token=${token.slice(0,8)}..., reason=revoked`);
      return { valid: false, reason: 'revoked' };
    }
    if (link.expiresAt && link.expiresAt < new Date()) {
      this.logger.warn(`Shared link access denied: token=${token.slice(0,8)}..., reason=expired`);
      return { valid: false, reason: 'expired' };
    }

    // Increment access count
    await this.prisma.sharedLink.update({
      where: { id: link.id },
      data: { accessCount: { increment: 1 }, lastAccessedAt: new Date() },
    }).catch((err) => this.logger.warn(`[validateLink] access count update failed: ${err.message}`));

    // Load data based on link type
    let data: any = null;
    if (link.linkType === 'FREIGHT' && link.freightId) {
      data = await this.prisma.freight.findUnique({
        where: { id: link.freightId },
        include: {
          items: true,
          originCompany: { select: { id: true, name: true } },
          destCompany: { select: { id: true, name: true } },
          destPlant: { select: { id: true, name: true } },
          field: { select: { id: true, name: true } },
          producerCompany: { select: { id: true, name: true } },
          assignments: {
            where: { status: { in: ['active', 'accepted'] } },
            select: {
              id: true,
              tripNumber: true,
              transportCompanyId: true,
              plate: true,
              driverName: true,
              status: true,
              tripStatus: true,
              startedAt: true,
              loadedAt: true,
              transportCompany: { select: { id: true, name: true } },
            },
          },
          auditLogs: {
            where: { action: { in: ['created', 'status_changed', 'assigned', 'accepted', 'started', 'loaded', 'finished', 'auto_started', 'auto_loaded', 'auto_transporter_confirmed', 'trip_started', 'trip_confirm_loaded'] } },
            select: { action: true, toValue: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    } else if (link.linkType === 'TICKET' && link.ticketId) {
      data = await this.prisma.weighTicket.findUnique({
        where: { id: link.ticketId },
        include: {
          freight: { select: { id: true, code: true, status: true } },
        },
      });
    } else if (link.linkType === 'PORTAL') {
      // Load summary + freight list for portal
      const targetId = link.targetCompanyId;
      const activeStatuses = ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded'] as any;
      const companyFilter = { OR: [{ originCompanyId: targetId }, { producerCompanyId: targetId }] };
      const [totalFreights, activeFreights, lastFreight, freightList] = await Promise.all([
        this.prisma.freight.count({ where: companyFilter }),
        this.prisma.freight.count({
          where: { status: { in: activeStatuses }, ...companyFilter },
        }),
        this.prisma.freight.findFirst({
          where: companyFilter,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        this.prisma.freight.findMany({
          where: companyFilter,
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true, code: true, status: true, originName: true, destName: true,
            createdAt: true, loadDate: true, loadTime: true, notes: true,
            originLat: true, originLng: true, destLat: true, destLng: true,
            routePolyline: true, routeDistanceKm: true, routeDurationMin: true,
            items: { select: { grain: true, tons: true } },
            originCompany: { select: { id: true, name: true } },
            destCompany: { select: { id: true, name: true } },
            destPlant: { select: { id: true, name: true } },
            field: { select: { id: true, name: true } },
            producerCompany: { select: { id: true, name: true } },
            assignments: {
              where: { status: { in: ['active', 'accepted'] } },
              select: {
                id: true, tripNumber: true, plate: true, driverName: true,
                status: true, tripStatus: true, startedAt: true, loadedAt: true,
                transportCompanyId: true,
                transportCompany: { select: { id: true, name: true } },
              },
            },
            auditLogs: {
              where: { action: { in: ['created', 'status_changed', 'assigned', 'accepted', 'started', 'loaded', 'finished', 'auto_started', 'auto_loaded', 'auto_transporter_confirmed', 'trip_started', 'trip_confirm_loaded'] } },
              select: { action: true, toValue: true, createdAt: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        }),
      ]);
      // Calculate total tons from items
      const totalTons = freightList.reduce((sum: number, f: any) => sum + (f.items || []).reduce((s: number, i: any) => s + (Number(i.tons) || 0), 0), 0);
      data = {
        targetCompanyName: link.targetCompany.name,
        totalFreights,
        activeFreights,
        totalTons,
        lastFreightAt: lastFreight?.createdAt || null,
        freights: freightList,
      };
    }

    return {
      valid: true,
      linkType: link.linkType,
      creatorCompanyName: link.creatorCompany.name,
      targetCompanyName: link.targetCompany.name,
      data,
    };
  }

  async revokeLink(id: string, user: any) {
    const link = await this.prisma.sharedLink.findUnique({ where: { id } });
    if (!link) throw new NotFoundException('Link no encontrado');
    const companyId = user.activeCompanyId || user.companyId;
    if (link.creatorCompanyId !== companyId && user.role !== 'platform_admin') {
      throw new BadRequestException('No tenés permiso para revocar este link');
    }
    return this.prisma.sharedLink.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  async regenerateLink(id: string, user: any) {
    const old = await this.prisma.sharedLink.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('Link no encontrado');

    // Revoke old
    await this.prisma.sharedLink.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    // Create new with same params
    return this.createLink({
      linkType: old.linkType,
      targetCompanyId: old.targetCompanyId,
      freightId: old.freightId || undefined,
      ticketId: old.ticketId || undefined,
      createdVia: old.createdVia,
    }, user);
  }

  async listByCompany(companyId: string, linkType?: string) {
    return this.prisma.sharedLink.findMany({
      where: {
        creatorCompanyId: companyId,
        ...(linkType ? { linkType: linkType as any } : {}),
        revokedAt: null,
      },
      include: {
        targetCompany: { select: { id: true, name: true } },
        freight: { select: { id: true, code: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}

// ======================== AUTHENTICATED CONTROLLER ====================

@ApiTags('Shared Links')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('shared-links')
export class SharedLinksController {
  constructor(private service: SharedLinksService) {}

  @Post()
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Crear link compartible' })
  create(@Body() dto: CreateSharedLinkDto, @CurrentUser() user: any) {
    return this.service.createLink(dto, user);
  }

  @Get('company/:companyId')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Listar links de una empresa' })
  listByCompany(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('type') type?: string,
  ) {
    return this.service.listByCompany(companyId, type);
  }

  @Patch(':id/revoke')
  @Roles('producer', 'plant', 'transporter')
  @ApiOperation({ summary: 'Revocar link' })
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.revokeLink(id, user);
  }

  @Post(':id/regenerate')
  @Roles('producer', 'plant', 'transporter')
  @ApiOperation({ summary: 'Regenerar link (revoca el anterior)' })
  regenerate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.regenerateLink(id, user);
  }
}

// ======================== PUBLIC CONTROLLER ============================

@ApiTags('Shared Links (Public)')
@Controller('s')
export class SharedLinksPublicController {
  constructor(private service: SharedLinksService) {}

  @Get(':token')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Resolver link compartible (público)' })
  resolve(@Param('token') token: string) {
    if (!token || token.length < 10) throw new BadRequestException('Token inválido');
    return this.service.resolveToken(token);
  }

  @Get(':token/data')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Datos del link compartible (JSON para SPA)' })
  resolveData(@Param('token') token: string) {
    if (!token || token.length < 10) throw new BadRequestException('Token inválido');
    return this.service.resolveToken(token);
  }
}

// ======================== MODULE =====================================

@Module({
  imports: [DatabaseModule],
  controllers: [SharedLinksController, SharedLinksPublicController],
  providers: [SharedLinksService],
  exports: [SharedLinksService],
})
export class SharedLinksModule {}
