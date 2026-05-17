import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FreightLocationsService } from '../../freight-locations/freight-locations.service';

type AllowedPublicType = 'ORIGIN' | 'DESTINATION' | 'POINT_OF_INTEREST';

export type LocationMatch = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  kind: 'field' | 'plant' | 'poi' | 'tolvink_plant';
  score: number;
};

@Injectable()
export class AgentV2LocationTools {
  constructor(
    private freightLocations: FreightLocationsService,
    private prisma: PrismaService,
  ) {}

  async generatePublicMapLink(
    freightId: string,
    opts: {
      allowedTypes?: AllowedPublicType[];
      ttlMinutes?: number;
      purpose?: string;
      createdByUserId?: string;
    } = {},
  ): Promise<{ url: string; ttlMinutes: number; allowedTypes: string[]; jti: string }> {
    const result = await this.freightLocations.createPublicMapLink(freightId, {
      allowedTypes: opts.allowedTypes,
      ttlMinutes: opts.ttlMinutes,
      purpose: opts.purpose || 'agent_v2',
      createdByUserId: opts.createdByUserId,
    });
    return {
      url: result.url,
      ttlMinutes: result.expiresInMinutes,
      allowedTypes: result.allowedTypes,
      jti: result.jti,
    };
  }

  /**
   * Busca ubicaciones guardadas por el usuario que matcheen `query`.
   * - origin: prioriza Field y Poi del/los company del usuario.
   * - destination: prioriza Plant accesible y TolvinkPlant del directorio maestro.
   * Devuelve hasta 5 matches. Si esta vacio, el flujo cae a map picker.
   */
  async resolveUserLocation(
    query: string,
    type: 'origin' | 'destination',
    user: any,
  ): Promise<LocationMatch[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const companyIds = this.collectCompanyIds(user);
    if (companyIds.length === 0) return [];

    try {
      if (type === 'origin') return await this.searchOrigin(q, companyIds);
      return await this.searchDestination(q, companyIds);
    } catch {
      return [];
    }
  }

  private async searchOrigin(query: string, companyIds: string[]): Promise<LocationMatch[]> {
    const [fields, pois] = await Promise.all([
      this.prisma.field.findMany({
        where: {
          active: true,
          name: { contains: query, mode: 'insensitive' },
          OR: [{ companyId: { in: companyIds } }, { ownerCompanyId: { in: companyIds } }],
        },
        select: { id: true, name: true, lat: true, lng: true, lots: { where: { active: true }, select: { lat: true, lng: true }, take: 1 } },
        take: 10,
      }),
      this.prisma.poi.findMany({
        where: { active: true, companyId: { in: companyIds }, name: { contains: query, mode: 'insensitive' } },
        select: { id: true, name: true, lat: true, lng: true },
        take: 10,
      }),
    ]);

    const matches: LocationMatch[] = [];
    for (const f of fields) {
      const lat = f.lat != null ? Number(f.lat) : f.lots?.[0]?.lat != null ? Number(f.lots[0].lat) : null;
      const lng = f.lng != null ? Number(f.lng) : f.lots?.[0]?.lng != null ? Number(f.lots[0].lng) : null;
      if (lat == null || lng == null) continue;
      matches.push({ id: f.id, label: f.name, lat, lng, kind: 'field', score: similarity(query, f.name) });
    }
    for (const p of pois) {
      matches.push({ id: p.id, label: p.name, lat: Number(p.lat), lng: Number(p.lng), kind: 'poi', score: similarity(query, p.name) });
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  private async searchDestination(query: string, companyIds: string[]): Promise<LocationMatch[]> {
    const matches: LocationMatch[] = [];

    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId: { in: companyIds }, active: true },
      select: {
        plantCompany: {
          select: {
            plants: {
              where: { active: true, name: { contains: query, mode: 'insensitive' } },
              select: { id: true, name: true, lat: true, lng: true },
            },
          },
        },
      },
    });
    for (const a of accesses) {
      for (const p of a.plantCompany?.plants || []) {
        if (p.lat == null || p.lng == null) continue;
        matches.push({ id: p.id, label: p.name, lat: Number(p.lat), lng: Number(p.lng), kind: 'plant', score: similarity(query, p.name) });
      }
    }

    const masterPlants = await this.prisma.tolvinkPlant.findMany({
      where: {
        active: true,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { altName: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, altName: true, locality: true, lat: true, lng: true },
      take: 10,
    });
    for (const p of masterPlants) {
      if (p.lat == null || p.lng == null) continue;
      const label = p.locality ? `${p.name} (${p.locality})` : p.name;
      matches.push({ id: p.id, label, lat: Number(p.lat), lng: Number(p.lng), kind: 'tolvink_plant', score: similarity(query, p.name) });
    }

    const seen = new Set<string>();
    const dedup = matches.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    return dedup.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  private collectCompanyIds(user: any): string[] {
    const ids = new Set<string>();
    if (user?.activeCompanyId) ids.add(user.activeCompanyId);
    if (user?.companyId) ids.add(user.companyId);
    for (const m of user?.memberships || []) {
      if (m?.companyId && m?.active !== false) ids.add(m.companyId);
    }
    return Array.from(ids);
  }
}

/** Score simple: 1.0 exacto, 0.9 prefijo, 0.7 contiene, fallback por tokens. */
function similarity(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1;
  if (c.startsWith(q)) return 0.9;
  if (c.includes(q)) return 0.7;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const hits = tokens.filter((t) => c.includes(t)).length;
  return 0.3 + 0.4 * (hits / tokens.length);
}

function normalize(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
