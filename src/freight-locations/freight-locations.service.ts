import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { createSignedToken, verifySignedToken } from '../common/signed-token';

type LocationType =
  | 'ORIGIN'
  | 'DESTINATION'
  | 'POINT_OF_INTEREST'
  | 'LOAD_LOCATION'
  | 'UNLOAD_LOCATION'
  | 'OPERATIONAL_REFERENCE'
  | 'OTHER';

type LocationInput = {
  type: LocationType;
  lat: number;
  lng: number;
  label?: string;
  address?: string;
  description?: string;
  companyId?: string;
  inputMethod?: 'BROWSER_CURRENT' | 'PIN_MANUAL' | 'SEARCH' | 'WHATSAPP_NATIVE' | 'UNKNOWN';
};

type MapTokenPayload = {
  fid: string;
  uid?: string;
  cid?: string;
  mode?: 'read' | 'edit';
  source?: 'WEB_APP' | 'SHARED_LINK' | 'WHATSAPP_AGENT' | 'PUBLIC_LINK';
  purpose?: string;
  anon?: boolean;
  allowedTypes?: LocationType[];
  jti?: string;
};

const REPLACING_TYPES = new Set<LocationType>(['ORIGIN', 'DESTINATION', 'LOAD_LOCATION', 'UNLOAD_LOCATION']);

const DEFAULT_PUBLIC_TYPES: LocationType[] = ['ORIGIN', 'DESTINATION', 'POINT_OF_INTEREST'];
const PUBLIC_LINK_DEFAULT_TTL_MIN = 24 * 60;
const PUBLIC_LINK_RATE_LIMIT_PER_TOKEN = 30; // saves per token lifetime (in-memory)

@Injectable()
export class FreightLocationsService {
  // In-memory rate limit per public token (jti -> count). Cleared on process restart.
  // Acceptable for Stage 1 because tokens are short-lived; if multi-instance, move to DB or Redis.
  private publicTokenSaves = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  // ======================== PUBLIC LINK (no-auth) ========================

  async createPublicMapLink(freightId: string, opts?: {
    allowedTypes?: LocationType[];
    ttlMinutes?: number;
    purpose?: string;
    createdByUserId?: string;
  }) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: { id: true, code: true },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    const allowedTypes = this.normalizeAllowedTypes(opts?.allowedTypes);
    const ttl = Math.min(Math.max(opts?.ttlMinutes || PUBLIC_LINK_DEFAULT_TTL_MIN, 5), 7 * 24 * 60);
    const jti = randomUUID();

    const token = createSignedToken({
      fid: freightId,
      mode: 'edit',
      source: 'PUBLIC_LINK',
      anon: true,
      allowedTypes,
      purpose: opts?.purpose,
      jti,
    }, this.getSecret(), ttl);

    if (opts?.createdByUserId) {
      await this.prisma.auditLog.create({
        data: {
          entityType: 'freight_location',
          entityId: freightId,
          action: 'public_map_link_created',
          userId: opts.createdByUserId,
          freightId,
          metadata: { jti, allowedTypes, ttlMinutes: ttl, purpose: opts?.purpose || null },
        },
      }).catch(() => undefined);
    }

    return {
      token,
      jti,
      url: `${this.getAppUrl()}/api/freight-map-public/${token}`,
      expiresInMinutes: ttl,
      allowedTypes,
    };
  }

  async getPublicMapData(token: string) {
    const payload = this.verifyMapToken(token);
    if (payload.source !== 'PUBLIC_LINK' || !payload.anon) {
      throw new ForbiddenException('Este enlace no es de uso publico');
    }
    const allowedTypes = this.normalizeAllowedTypes(payload.allowedTypes);
    const data = await this.buildMapData(payload.fid, {
      canEdit: true,
      source: 'PUBLIC_LINK',
      actorCompanyId: undefined,
      actorCompanies: [],
      purpose: payload.purpose,
    });
    return {
      ...data,
      freight: {
        ...data.freight,
        assignments: [],
      },
      locations: data.locations
        .filter((loc) => allowedTypes.includes(loc.type as LocationType))
        .map((loc) => ({
          id: loc.id,
          type: loc.type,
          status: loc.status,
          lat: loc.lat,
          lng: loc.lng,
          label: loc.label,
          address: loc.address,
          description: loc.description,
          source: loc.source,
          inputMethod: loc.inputMethod,
          createdAt: loc.createdAt,
        })),
      liveLocations: [],
      permissions: {
        ...data.permissions,
        anonymous: true,
        allowedTypes,
      },
    };
  }

  async savePublicLocation(token: string, input: LocationInput) {
    const payload = this.verifyMapToken(token);
    if (payload.source !== 'PUBLIC_LINK' || !payload.anon || payload.mode === 'read') {
      throw new ForbiddenException('Este enlace no permite guardar ubicaciones');
    }
    const allowed = this.normalizeAllowedTypes(payload.allowedTypes);
    if (!allowed.includes(input.type)) {
      throw new BadRequestException(`Tipo no permitido para este enlace. Permitidos: ${allowed.join(', ')}`);
    }
    const jti = payload.jti || 'no-jti';
    const used = this.publicTokenSaves.get(jti) || 0;
    if (used >= PUBLIC_LINK_RATE_LIMIT_PER_TOKEN) {
      throw new ForbiddenException('Este enlace alcanzo el maximo de ubicaciones permitidas. Solicita uno nuevo.');
    }
    this.publicTokenSaves.set(jti, used + 1);

    this.validateLocationInput(input);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.freightLocation.create({
        data: {
          freightId: payload.fid,
          userId: null,
          userName: null,
          companyId: null,
          companyName: null,
          actorRole: 'public_link',
          type: input.type as any,
          lat: input.lat,
          lng: input.lng,
          label: input.label?.trim() || null,
          address: input.address?.trim() || null,
          description: input.description?.trim() || null,
          source: 'PUBLIC_LINK' as any,
          inputMethod: (input.inputMethod || 'PIN_MANUAL') as any,
        },
      });

      if (REPLACING_TYPES.has(input.type)) {
        await tx.freightLocation.updateMany({
          where: {
            freightId: payload.fid,
            type: input.type as any,
            status: 'ACTIVE',
            id: { not: created.id },
          },
          data: { status: 'REPLACED', replacedById: created.id },
        });
      }

      // No auditLog row here: AuditLog.userId is required, and these saves are anonymous.
      // The trail lives in FreightLocation: source=PUBLIC_LINK + inputMethod + actorRole='public_link'.
      // The link emission already left an auditLog ('public_map_link_created') with the jti.

      return { success: true, location: created };
    });
  }

  private normalizeAllowedTypes(input?: LocationType[] | string[]): LocationType[] {
    const validValues = new Set<LocationType>([
      'ORIGIN', 'DESTINATION', 'POINT_OF_INTEREST', 'LOAD_LOCATION',
      'UNLOAD_LOCATION', 'OPERATIONAL_REFERENCE', 'OTHER',
    ]);
    const raw = Array.isArray(input) ? input : [];
    const filtered = raw
      .map((v) => String(v).toUpperCase())
      .filter((v): v is LocationType => validValues.has(v as LocationType));
    return filtered.length ? Array.from(new Set(filtered)) : [...DEFAULT_PUBLIC_TYPES];
  }
  // ======================== END PUBLIC LINK ==============================


  async createMapLink(freightId: string, user: any, opts?: {
    mode?: 'read' | 'edit';
    source?: 'WEB_APP' | 'SHARED_LINK' | 'WHATSAPP_AGENT';
    purpose?: string;
    ttlMinutes?: number;
  }) {
    const actor = await this.resolveActor(user, freightId);
    const payload: MapTokenPayload = {
      fid: freightId,
      uid: actor.userId,
      cid: actor.companyId,
      mode: opts?.mode || 'edit',
      source: opts?.source || 'WEB_APP',
      purpose: opts?.purpose,
    };
    const token = createSignedToken(payload, this.getSecret(), opts?.ttlMinutes || 7 * 24 * 60);
    return {
      token,
      url: `${this.getAppUrl()}/api/freight-map/${token}`,
      expiresInMinutes: opts?.ttlMinutes || 7 * 24 * 60,
    };
  }

  async getAuthenticatedMapData(freightId: string, user: any) {
    const actor = await this.resolveActor(user, freightId);
    return this.buildMapData(freightId, {
      canEdit: true,
      source: 'WEB_APP',
      actorCompanyId: actor.companyId,
      actorCompanies: actor.actorCompanies,
    });
  }

  async getTokenMapData(token: string) {
    const payload = this.verifyMapToken(token);
    await this.assertTokenFreightAccess(payload);
    return this.buildMapData(payload.fid, {
      canEdit: payload.mode !== 'read' && !!payload.uid && !!payload.cid,
      source: payload.source || 'SHARED_LINK',
      actorCompanyId: payload.cid,
      actorCompanies: [],
      purpose: payload.purpose,
    });
  }

  async saveAuthenticatedLocation(freightId: string, user: any, input: LocationInput) {
    const actor = await this.resolveActor(user, freightId, input.companyId);
    return this.createLocation(freightId, actor, {
      ...input,
      source: 'WEB_APP',
    });
  }

  async saveTokenLocation(token: string, input: LocationInput) {
    const payload = this.verifyMapToken(token);
    if (payload.mode === 'read' || !payload.uid || !payload.cid) {
      throw new ForbiddenException('Este enlace no permite guardar ubicaciones');
    }
    await this.assertTokenFreightAccess(payload);
    const actor = await this.resolveActor({ id: payload.uid, activeCompanyId: payload.cid }, payload.fid, payload.cid);
    return this.createLocation(payload.fid, actor, {
      ...input,
      source: payload.source || 'SHARED_LINK',
    });
  }

  private async buildMapData(freightId: string, context: {
    canEdit: boolean;
    source: string;
    actorCompanyId?: string;
    actorCompanies: Array<{ id: string; name: string; role: string }>;
    purpose?: string;
  }) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        id: true,
        code: true,
        status: true,
        originName: true,
        originLat: true,
        originLng: true,
        destName: true,
        destLat: true,
        destLng: true,
        loadDate: true,
        loadTime: true,
        items: { select: { grain: true, tons: true }, take: 1 },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: {
            id: true,
            tripNumber: true,
            plate: true,
            driverName: true,
            tripStatus: true,
            transportCompany: { select: { id: true, name: true } },
          },
          orderBy: { tripNumber: 'asc' },
        },
        locations: {
          where: { status: { in: ['ACTIVE', 'REPLACED', 'HISTORICAL'] } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        liveLocations: {
          where: { active: true, expiresAt: { gt: new Date() } },
          select: { id: true, userName: true, userRole: true, lat: true, lng: true, updatedAt: true },
          take: 20,
        },
      },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    return {
      freight: {
        id: freight.id,
        code: freight.code,
        status: freight.status,
        originName: freight.originName,
        destName: freight.destName,
        loadDate: freight.loadDate,
        loadTime: freight.loadTime,
        item: freight.items[0] || null,
        assignments: freight.assignments,
        origin: this.pointOrNull('ORIGIN', freight.originName, freight.originLat, freight.originLng),
        destination: this.pointOrNull('DESTINATION', freight.destName, freight.destLat, freight.destLng),
      },
      permissions: {
        canEdit: context.canEdit,
        source: context.source,
        actorCompanyId: context.actorCompanyId || null,
        actorCompanies: context.actorCompanies,
        purpose: context.purpose || null,
      },
      locations: freight.locations.map((loc) => ({
        id: loc.id,
        type: loc.type,
        status: loc.status,
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        label: loc.label,
        address: loc.address,
        description: loc.description,
        userName: loc.userName,
        companyName: loc.companyName,
        actorRole: loc.actorRole,
        source: loc.source,
        inputMethod: loc.inputMethod,
        createdAt: loc.createdAt,
      })),
      liveLocations: freight.liveLocations.map((loc) => ({
        id: loc.id,
        type: 'CURRENT',
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        label: loc.userName,
        actorRole: loc.userRole,
        updatedAt: loc.updatedAt,
      })),
    };
  }

  private async createLocation(freightId: string, actor: any, input: LocationInput & { source: string }) {
    this.validateLocationInput(input);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.freightLocation.create({
        data: {
          freightId,
          userId: actor.userId,
          userName: actor.userName,
          companyId: actor.companyId,
          companyName: actor.companyName,
          actorRole: actor.actorRole,
          type: input.type as any,
          lat: input.lat,
          lng: input.lng,
          label: input.label?.trim() || null,
          address: input.address?.trim() || null,
          description: input.description?.trim() || null,
          source: input.source as any,
          inputMethod: (input.inputMethod || 'UNKNOWN') as any,
        },
      });

      if (REPLACING_TYPES.has(input.type)) {
        await tx.freightLocation.updateMany({
          where: {
            freightId,
            type: input.type as any,
            status: 'ACTIVE',
            id: { not: created.id },
          },
          data: { status: 'REPLACED', replacedById: created.id },
        });
      }

      await tx.auditLog.create({
        data: {
          entityType: 'freight_location',
          entityId: created.id,
          action: 'location_created',
          toValue: JSON.stringify({
            type: created.type,
            lat: Number(created.lat),
            lng: Number(created.lng),
            label: created.label,
            companyId: created.companyId,
            source: created.source,
            inputMethod: created.inputMethod,
          }),
          userId: actor.userId,
          freightId,
          metadata: {
            companyId: actor.companyId,
            companyName: actor.companyName,
            actorRole: actor.actorRole,
          },
        },
      });

      return { success: true, location: created };
    });
  }

  private async resolveActor(user: any, freightId: string, requestedCompanyId?: string) {
    const userId = user?.sub || user?.id;
    if (!userId) throw new ForbiddenException('Usuario no identificado');

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { where: { active: true }, include: { company: true } }, company: true, activeCompany: true },
    });
    if (!dbUser) throw new ForbiddenException('Usuario no encontrado');

    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        originCompanyId: true,
        destCompanyId: true,
        producerCompanyId: true,
        requestedById: true,
        participantCompanyIds: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true, driverId: true } },
      },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    const participatingCompanyIds = new Set([
      freight.originCompanyId,
      freight.destCompanyId,
      freight.producerCompanyId,
      ...freight.participantCompanyIds,
      ...freight.assignments.map((a) => a.transportCompanyId),
    ].filter(Boolean) as string[]);

    const actorCompanies = dbUser.memberships
      .filter((m) => participatingCompanyIds.has(m.companyId))
      .map((m) => ({ id: m.companyId, name: m.company.name, role: m.role }));

    const isDriver = freight.assignments.some((a) => a.driverId === userId);
    const isCreator = freight.requestedById === userId;
    if (!actorCompanies.length && !isDriver && !isCreator && dbUser.role !== 'platform_admin') {
      throw new ForbiddenException('No tenes permiso para operar este mapa');
    }

    const preferredCompanyId = requestedCompanyId || user.activeCompanyId || dbUser.activeCompanyId || user.companyId || dbUser.companyId;
    let membership = actorCompanies.find((c) => c.id === preferredCompanyId);
    if (!membership && actorCompanies.length === 1) membership = actorCompanies[0];
    if (!membership && dbUser.role === 'platform_admin') {
      const company = await this.prisma.company.findUnique({ where: { id: freight.originCompanyId } });
      if (!company) throw new ForbiddenException('No se pudo determinar empresa de actuacion');
      membership = { id: company.id, name: company.name, role: 'platform_admin' };
    }
    if (!membership && actorCompanies.length > 1) {
      throw new BadRequestException({
        message: 'Selecciona con que empresa queres guardar la ubicacion',
        companies: actorCompanies,
      });
    }
    if (!membership) throw new ForbiddenException('No se pudo determinar empresa de actuacion');

    return {
      userId,
      userName: dbUser.name,
      companyId: membership.id,
      companyName: membership.name,
      actorRole: isDriver ? 'chofer' : membership.role || dbUser.role,
      actorCompanies,
    };
  }

  private async assertTokenFreightAccess(payload: MapTokenPayload) {
    if (!payload.fid) throw new BadRequestException('Token invalido');
    if (!payload.uid || !payload.cid) return;
    await this.resolveActor({ id: payload.uid, activeCompanyId: payload.cid }, payload.fid, payload.cid);
  }

  private verifyMapToken(token: string): MapTokenPayload {
    if (!token || token.length < 20) throw new BadRequestException('Token invalido');
    const payload = verifySignedToken(token, this.getSecret());
    if (!payload?.fid) throw new BadRequestException('Token invalido o expirado');
    return payload as MapTokenPayload;
  }

  private validateLocationInput(input: LocationInput) {
    const validTypes = ['ORIGIN', 'DESTINATION', 'POINT_OF_INTEREST', 'LOAD_LOCATION', 'UNLOAD_LOCATION', 'OPERATIONAL_REFERENCE', 'OTHER'];
    if (!validTypes.includes(input.type)) throw new BadRequestException('Tipo de ubicacion invalido');
    if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new BadRequestException('Latitud invalida');
    if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) throw new BadRequestException('Longitud invalida');
    if (input.label && input.label.length > 255) input.label = input.label.slice(0, 255);
    if (input.address && input.address.length > 500) input.address = input.address.slice(0, 500);
  }

  private pointOrNull(type: string, label: string, lat: any, lng: any) {
    if (lat == null || lng == null) return null;
    return { type, label, lat: Number(lat), lng: Number(lng) };
  }

  private getSecret(): string {
    return this.config.get<string>('WHATSAPP_APP_SECRET')
      || this.config.get<string>('JWT_SECRET')
      || 'tolvink-dev-secret';
  }

  private getAppUrl(): string {
    return (
      this.config.get<string>('API_PUBLIC_URL')
      || (this.config.get<string>('RAILWAY_PUBLIC_DOMAIN') ? `https://${this.config.get<string>('RAILWAY_PUBLIC_DOMAIN')}` : '')
      || this.config.get<string>('FRONTEND_URL')
      || 'https://tolvink.com'
    ).replace(/\/$/, '');
  }

  getGoogleMapsKey(): string {
    return this.config.get<string>('GOOGLE_MAPS_API_KEY')
      || this.config.get<string>('VITE_GMAPS_KEY')
      || this.config.get<string>('VITE_GOOGLE_MAPS_PUBLIC_KEY')
      || this.config.get<string>('GOOGLE_PLACES_API_KEY')
      || '';
  }
}
