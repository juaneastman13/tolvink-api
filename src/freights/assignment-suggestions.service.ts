// =====================================================================
// TOLVINK — Assignment Suggestions Service
// Ranks transport options for plant users assigning a freight
// =====================================================================

import { Injectable, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { haversineDistanceOrNull } from '../common/helpers/haversine';

interface ScoreBreakdown {
  availability: number;
  proximity: number;
  history: number;
  routeAffinity: number;
  capacity: number;
}

interface HistoryStats {
  totalTrips: number;
  completedTrips: number;
  rejectionRate: number;
  routeTrips: number;
}

interface Suggestion {
  type: 'own_fleet' | 'transporter';
  companyId: string;
  companyName: string;
  truckId: string | null;
  plate: string | null;
  driverName: string | null;
  driverPhone: string | null;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  reasons: string[];
  availability: 'free' | 'busy_other_hours' | 'busy_now';
  estimatedDistanceKm: number | null;
  locationSource: 'live' | 'last_destination' | 'company_hq' | null;
  historyStats: HistoryStats;
}

export interface SuggestionResponse {
  suggestions: Suggestion[];
  freightId: string;
  freightCode: string;
  totalCandidatesEvaluated: number;
  scoringFactors: string[];
  geoAvailable: boolean;
}

interface Candidate {
  type: 'own_fleet' | 'transporter';
  companyId: string;
  companyName: string;
  truckId: string | null;
  plate: string | null;
  driverName: string | null;
  driverPhone: string | null;
  capacity: number | null; // parsed from Truck.capacity (string)
  hasRegisteredTrucks: boolean;
}

@Injectable()
export class AssignmentSuggestionsService {
  private readonly logger = new Logger(AssignmentSuggestionsService.name);

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {}

  async getSuggestions(freightId: string, requestingUserId: string): Promise<SuggestionResponse> {
    // ── Load freight ────────────────────────────────────────────
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: {
        items: { select: { tons: true } },
        originCompany: { select: { id: true, hasInternalFleet: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: { transportCompanyId: true, truckId: true },
        },
      },
    });
    if (!freight) throw new BadRequestException('Flete no encontrado');

    // ── Status check ────────────────────────────────────────────
    const canSuggest =
      freight.status === 'pending_assignment' ||
      (freight.status === 'assigned' && freight.assignedTruckCount < freight.truckCount);
    if (!canSuggest) {
      throw new BadRequestException('El flete no está en estado de asignación');
    }

    // ── Permission check — user must have plant role for dest or origin company ──
    if (!requestingUserId) throw new ForbiddenException('Usuario no identificado');
    const user = await this.prisma.user.findUnique({
      where: { id: requestingUserId },
      select: { id: true, companyId: true, role: true, isSuperAdmin: true },
    });
    if (!user) throw new ForbiddenException('Usuario no encontrado');

    if (!user.isSuperAdmin) {
      const allIds = await this.companyRes.resolveAllCompanyIds(user as any);
      const memberships = await this.prisma.userCompany.findMany({
        where: { userId: user.id, active: true },
        include: { company: { select: { id: true, type: true, types: true } } },
      });
      const plantCompanyIds = memberships
        .filter(m => {
          const types = Array.isArray(m.company.types) && (m.company.types as string[]).length > 0
            ? (m.company.types as string[]) : [m.company.type];
          return types.includes('plant');
        })
        .map(m => m.companyId);

      const hasPlantAccess =
        (freight.destCompanyId && plantCompanyIds.includes(freight.destCompanyId)) ||
        plantCompanyIds.includes(freight.originCompanyId);

      if (!hasPlantAccess) {
        throw new ForbiddenException('Solo la planta puede solicitar sugerencias de asignación');
      }
    }

    // ── Geo availability ────────────────────────────────────────
    const originLat = freight.originLat ? Number(freight.originLat) : null;
    const originLng = freight.originLng ? Number(freight.originLng) : null;
    const geoAvailable = originLat != null && originLng != null;

    // ── Required tonnage ────────────────────────────────────────
    const requiredTons = freight.items.reduce((s, i) => s + Number(i.tons || 0), 0);

    // ── Build candidate pool ────────────────────────────────────
    const candidates = await this.buildCandidatePool(freight);
    const totalCandidatesEvaluated = candidates.length;

    // ── Batch-fetch scoring data for all candidates ────────────
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const allCompanyIds = [...new Set(candidates.map(c => c.companyId))];
    const allTruckIds = candidates.map(c => c.truckId).filter(Boolean) as string[];

    // Pre-fetch all data in parallel batches
    const [historyAssignments, routeAssignments, availabilityConflicts] = await Promise.all([
      // History: all assignments for all candidate companies in last 90 days
      this.prisma.freightAssignment.findMany({
        where: { transportCompanyId: { in: allCompanyIds }, createdAt: { gte: ninetyDaysAgo } },
        select: { transportCompanyId: true, tripStatus: true, status: true },
      }),
      // Route affinity: finished assignments matching origin/dest
      this.prisma.freightAssignment.count ? this.prisma.freightAssignment.findMany({
        where: {
          transportCompanyId: { in: allCompanyIds },
          createdAt: { gte: ninetyDaysAgo },
          tripStatus: 'finished',
          freight: {
            originCompanyId: freight.originCompanyId,
            ...(freight.destCompanyId ? { destCompanyId: freight.destCompanyId } : {}),
          },
        },
        select: { transportCompanyId: true },
      }) : Promise.resolve([]),
      // Availability: active assignments on the load date for all candidate trucks/companies
      (() => {
        const loadDate = freight.loadDate ? new Date(freight.loadDate) : null;
        if (!loadDate) return Promise.resolve([]);
        const dayStart = new Date(loadDate); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(loadDate); dayEnd.setHours(23, 59, 59, 999);
        const where: any = {
          tripStatus: { in: ['accepted', 'in_progress', 'loaded'] },
          freight: { loadDate: { gte: dayStart, lte: dayEnd } },
          OR: [
            ...(allTruckIds.length > 0 ? [{ truckId: { in: allTruckIds } }] : []),
            { transportCompanyId: { in: allCompanyIds } },
          ],
        };
        return this.prisma.freightAssignment.findMany({
          where,
          select: { truckId: true, transportCompanyId: true, freight: { select: { loadTime: true } } },
        });
      })(),
    ]);

    // Index batch results by companyId
    const historyByCompany = new Map<string, typeof historyAssignments>();
    for (const a of historyAssignments) {
      const arr = historyByCompany.get(a.transportCompanyId) || [];
      arr.push(a);
      historyByCompany.set(a.transportCompanyId, arr);
    }
    const routeCountByCompany = new Map<string, number>();
    for (const a of routeAssignments) {
      routeCountByCompany.set(a.transportCompanyId, (routeCountByCompany.get(a.transportCompanyId) || 0) + 1);
    }
    const availByTruck = new Map<string, typeof availabilityConflicts>();
    const availByCompany = new Map<string, typeof availabilityConflicts>();
    for (const a of availabilityConflicts) {
      if (a.truckId) {
        const arr = availByTruck.get(a.truckId) || [];
        arr.push(a);
        availByTruck.set(a.truckId, arr);
      }
      const arr = availByCompany.get(a.transportCompanyId) || [];
      arr.push(a);
      availByCompany.set(a.transportCompanyId, arr);
    }

    // Score all candidates using batched data
    const scored = await Promise.all(
      candidates.map(c => this.scoreCandidateBatched(
        c, freight, originLat, originLng, geoAvailable, requiredTons,
        historyByCompany.get(c.companyId) || [],
        routeCountByCompany.get(c.companyId) || 0,
        c.truckId ? (availByTruck.get(c.truckId) || []) : (availByCompany.get(c.companyId) || []),
      )),
    );

    // ── Sort ────────────────────────────────────────────────────
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.historyStats.routeTrips !== a.historyStats.routeTrips) return b.historyStats.routeTrips - a.historyStats.routeTrips;
      if (b.historyStats.completedTrips !== a.historyStats.completedTrips) return b.historyStats.completedTrips - a.historyStats.completedTrips;
      return a.companyName.localeCompare(b.companyName);
    });

    // ── Own fleet priority boost ────────────────────────────────
    if (freight.useOwnFleet) {
      const ownIdx = scored.findIndex(s => s.type === 'own_fleet' && s.score >= 60);
      if (ownIdx > 0) {
        const [own] = scored.splice(ownIdx, 1);
        scored.unshift(own);
      }
    }

    return {
      suggestions: scored.slice(0, 8),
      freightId,
      freightCode: freight.code,
      totalCandidatesEvaluated,
      scoringFactors: ['availability', 'proximity', 'history', 'route_affinity', 'capacity'],
      geoAvailable,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // CANDIDATE POOL
  // ══════════════════════════════════════════════════════════════

  private async buildCandidatePool(freight: any): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const existingAssignments = new Set(freight.assignments.map((a: any) => a.transportCompanyId));

    // A) Own fleet
    if (freight.originCompany?.hasInternalFleet || freight.useOwnFleet) {
      const trucks = await this.prisma.truck.findMany({
        where: { companyId: freight.originCompanyId, active: true },
        include: { assignedUser: { select: { name: true, phone: true } } },
      });
      const originCompany = await this.prisma.company.findUnique({
        where: { id: freight.originCompanyId },
        select: { name: true },
      });
      for (const t of trucks) {
        candidates.push({
          type: 'own_fleet',
          companyId: freight.originCompanyId,
          companyName: originCompany?.name || 'Flota propia',
          truckId: t.id,
          plate: t.plate,
          driverName: t.assignedUser?.name || null,
          driverPhone: t.assignedUser?.phone || null,
          capacity: t.capacity ? parseFloat(t.capacity) || null : null,
          hasRegisteredTrucks: true,
        });
      }
    }

    // B) External transporters
    const transporters = await this.prisma.company.findMany({
      where: {
        active: true,
        OR: [
          { type: 'transporter' },
          { types: { array_contains: ['transporter'] } },
        ],
      },
      select: {
        id: true,
        name: true,
        lat: true,
        lng: true,
        trucks: {
          where: { active: true },
          include: { assignedUser: { select: { name: true, phone: true } } },
        },
      },
      take: 200,
    });

    for (const tc of transporters) {
      // Skip if already assigned to this freight (unless multi-truck)
      if (existingAssignments.has(tc.id) && !freight.isMultiTruck) continue;

      if (tc.trucks.length > 0) {
        // Each truck is a candidate
        for (const t of tc.trucks) {
          candidates.push({
            type: 'transporter',
            companyId: tc.id,
            companyName: tc.name,
            truckId: t.id,
            plate: t.plate,
            driverName: t.assignedUser?.name || null,
            driverPhone: t.assignedUser?.phone || null,
            capacity: t.capacity ? parseFloat(t.capacity) || null : null,
            hasRegisteredTrucks: true,
          });
        }
      } else {
        // Company as a whole (no registered trucks)
        candidates.push({
          type: 'transporter',
          companyId: tc.id,
          companyName: tc.name,
          truckId: null,
          plate: null,
          driverName: null,
          driverPhone: null,
          capacity: null,
          hasRegisteredTrucks: false,
        });
      }
    }

    return candidates;
  }

  // ══════════════════════════════════════════════════════════════
  // SCORING
  // ══════════════════════════════════════════════════════════════

  /** Score using pre-fetched batched data (no individual DB queries) */
  private async scoreCandidateBatched(
    c: Candidate,
    freight: any,
    originLat: number | null,
    originLng: number | null,
    geoAvailable: boolean,
    requiredTons: number,
    historyAssignments: { tripStatus: string; status: string }[],
    routeTrips: number,
    availabilityConflicts: { truckId: string | null; transportCompanyId: string; freight: { loadTime: string | null } }[],
  ): Promise<Suggestion> {
    // Proximity still requires individual queries (live location, last destination, company HQ)
    const proxResult = await this.scoreProximity(c, originLat, originLng);

    // Availability from batched data
    const availResult = this.scoreAvailabilityBatched(c, freight, availabilityConflicts);

    // History from batched data
    const histResult = this.scoreHistoryBatched(historyAssignments);

    // Route affinity from batched data
    const routeResult = this.scoreRouteAffinityBatched(routeTrips);

    const capResult = this.scoreCapacity(c, requiredTons);

    return this.buildSuggestion(c, freight, geoAvailable, requiredTons, availResult, proxResult, histResult, routeResult, capResult);
  }

  private buildSuggestion(
    c: Candidate,
    freight: any,
    geoAvailable: boolean,
    requiredTons: number,
    availResult: { score: number; status: 'free' | 'busy_other_hours' | 'busy_now' },
    proxResult: { score: number; distanceKm: number | null; source: 'live' | 'last_destination' | 'company_hq' | null },
    histResult: { score: number; totalTrips: number; completedTrips: number; rejectedTrips: number; completionRate: number },
    routeResult: { score: number; routeTrips: number },
    capResult: { score: number },
  ): Suggestion {

    let breakdown: ScoreBreakdown;

    if (!geoAvailable) {
      // Redistribute proximity 25 pts proportionally among other 4 factors (×100/75)
      const scale = 100 / 75;
      breakdown = {
        availability: Math.round(availResult.score * scale),
        proximity: 0,
        history: Math.round(histResult.score * scale),
        routeAffinity: Math.round(routeResult.score * scale),
        capacity: Math.round(capResult.score * scale),
      };
    } else {
      breakdown = {
        availability: availResult.score,
        proximity: proxResult.score,
        history: histResult.score,
        routeAffinity: routeResult.score,
        capacity: capResult.score,
      };
    }

    const score = Math.min(100,
      breakdown.availability + breakdown.proximity + breakdown.history +
      breakdown.routeAffinity + breakdown.capacity,
    );

    // ── Build reasons ───────────────────────────────────────────
    const reasons: string[] = [];

    // Availability
    if (availResult.status === 'free') reasons.push(`Libre el ${this.fmtDate(freight.loadDate)}`);
    else if (availResult.status === 'busy_other_hours') reasons.push('Tiene viajes hoy pero en otros horarios');
    else reasons.push('Ocupado en ese horario');

    // Proximity
    if (geoAvailable && proxResult.distanceKm != null) {
      const d = Math.round(proxResult.distanceKm);
      if (d < 80) reasons.push(`A ~${d} km del origen`);
      else reasons.push(`A ~${d} km (lejano)`);
    }

    // History
    if (histResult.totalTrips === 0) {
      reasons.push('Sin historial previo');
    } else if (histResult.completionRate >= 0.9) {
      reasons.push(`${histResult.completedTrips} viajes completados, excelente historial`);
    } else {
      reasons.push(`${histResult.completedTrips} de ${histResult.totalTrips} viajes completados`);
    }

    // Route affinity
    if (routeResult.routeTrips > 0) {
      reasons.push(`Conoce la ruta (${routeResult.routeTrips} viajes previos)`);
    }

    // Capacity
    if (c.capacity != null && requiredTons > 0 && c.capacity < requiredTons) {
      reasons.push(`⚠️ Capacidad insuficiente (${c.capacity} tn vs ${requiredTons} tn)`);
    }

    return {
      type: c.type,
      companyId: c.companyId,
      companyName: c.companyName,
      truckId: c.truckId,
      plate: c.plate,
      driverName: c.driverName,
      driverPhone: c.driverPhone,
      score: Math.round(score),
      scoreBreakdown: breakdown,
      reasons,
      availability: availResult.status,
      estimatedDistanceKm: proxResult.distanceKm != null ? Math.round(proxResult.distanceKm) : null,
      locationSource: proxResult.source,
      historyStats: {
        totalTrips: histResult.totalTrips,
        completedTrips: histResult.completedTrips,
        rejectionRate: histResult.totalTrips > 0 ? Math.round((histResult.rejectedTrips / histResult.totalTrips) * 100) / 100 : 0,
        routeTrips: routeResult.routeTrips,
      },
    };
  }

  // ── FACTOR 2: Proximity (0-25 pts) ────────────────────────────
  private async scoreProximity(
    c: Candidate,
    originLat: number | null,
    originLng: number | null,
  ): Promise<{ score: number; distanceKm: number | null; source: 'live' | 'last_destination' | 'company_hq' | null }> {
    if (originLat == null || originLng == null) return { score: 12, distanceKm: null, source: null };

    // 1. Live location
    if (c.truckId) {
      const live = await this.prisma.liveLocation.findFirst({
        where: {
          active: true,
          expiresAt: { gt: new Date() },
          freight: {
            assignments: { some: { truckId: c.truckId } },
          },
        },
        select: { lat: true, lng: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (live) {
        const d = haversineDistanceOrNull(Number(live.lat), Number(live.lng), originLat, originLng);
        if (d != null) return { score: this.distScore(d), distanceKm: d, source: 'live' };
      }
    }

    // 2. Last completed destination
    const lastFinished = await this.prisma.freightAssignment.findFirst({
      where: { transportCompanyId: c.companyId, tripStatus: 'finished' },
      orderBy: { finishedAt: 'desc' },
      select: { freight: { select: { destLat: true, destLng: true } } },
    });
    if (lastFinished?.freight) {
      const d = haversineDistanceOrNull(
        Number(lastFinished.freight.destLat), Number(lastFinished.freight.destLng),
        originLat, originLng,
      );
      if (d != null) return { score: this.distScore(d), distanceKm: d, source: 'last_destination' };
    }

    // 3. Company HQ
    const company = await this.prisma.company.findUnique({
      where: { id: c.companyId },
      select: { lat: true, lng: true },
    });
    if (company) {
      const d = haversineDistanceOrNull(Number(company.lat), Number(company.lng), originLat, originLng);
      if (d != null) return { score: this.distScore(d), distanceKm: d, source: 'company_hq' };
    }

    // 4. No data
    return { score: 12, distanceKm: null, source: null };
  }

  private distScore(km: number): number {
    if (km < 15) return 25;
    if (km < 40) return 20;
    if (km < 80) return 15;
    if (km < 150) return 10;
    if (km < 300) return 5;
    return 2;
  }

  // ── FACTOR 5: Truck Capacity (0-10 pts) ───────────────────────
  private scoreCapacity(c: Candidate, requiredTons: number): { score: number } {
    if (!c.hasRegisteredTrucks || c.capacity == null) return { score: 5 };
    if (requiredTons <= 0) return { score: 10 };
    if (c.capacity >= requiredTons) return { score: 10 };
    return { score: 0 };
  }

  // ── Batched scoring variants (use pre-fetched data) ──────────

  private scoreAvailabilityBatched(
    c: Candidate,
    freight: any,
    conflicts: { truckId: string | null; transportCompanyId: string; freight: { loadTime: string | null } }[],
  ): { score: number; status: 'free' | 'busy_other_hours' | 'busy_now' } {
    // Filter conflicts relevant to this specific candidate
    const relevant = c.truckId
      ? conflicts.filter(cf => cf.truckId === c.truckId)
      : conflicts.filter(cf => cf.transportCompanyId === c.companyId);

    if (relevant.length === 0) return { score: 30, status: 'free' };

    if (freight.loadTime) {
      const freightHour = parseInt(freight.loadTime?.split(':')[0] ?? '8', 10);
      const hasOverlap = relevant.some(cf => {
        if (!cf.freight.loadTime) return true;
        const conflictHour = parseInt(cf.freight.loadTime?.split(':')[0] ?? '8', 10);
        return Math.abs(freightHour - conflictHour) < 4;
      });
      if (!hasOverlap) return { score: 20, status: 'busy_other_hours' };
    }

    if (!c.truckId) {
      if (relevant.length < 3) return { score: 30, status: 'free' };
      if (relevant.length < 6) return { score: 20, status: 'busy_other_hours' };
    }

    return { score: 5, status: 'busy_now' };
  }

  private scoreHistoryBatched(assignments: { tripStatus: string; status: string }[]): {
    score: number; totalTrips: number; completedTrips: number; rejectedTrips: number; completionRate: number;
  } {
    const totalTrips = assignments.length;
    if (totalTrips === 0) return { score: 10, totalTrips: 0, completedTrips: 0, rejectedTrips: 0, completionRate: 0 };

    const completedTrips = assignments.filter(a => a.tripStatus === 'finished').length;
    const rejectedTrips = assignments.filter(a => a.status === 'rejected').length;
    const completionRate = completedTrips / totalTrips;
    const rejectionRate = rejectedTrips / totalTrips;

    let score: number;
    if (completionRate >= 0.9 && rejectionRate < 0.05) score = 25;
    else if (completionRate >= 0.8) score = 20;
    else if (completionRate >= 0.65) score = 14;
    else score = 6;

    return { score, totalTrips, completedTrips, rejectedTrips, completionRate };
  }

  private scoreRouteAffinityBatched(routeTrips: number): { score: number; routeTrips: number } {
    let score: number;
    if (routeTrips >= 5) score = 10;
    else if (routeTrips >= 3) score = 7;
    else if (routeTrips >= 1) score = 4;
    else score = 0;
    return { score, routeTrips };
  }

  // ── Helpers ───────────────────────────────────────────────────
  private fmtDate(d: Date | string): string {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getDate()}/${dt.getMonth() + 1}`;
  }
}
