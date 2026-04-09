// =====================================================================
// TOLVINK — System prompt builder (Gemini rebuild)
// Preserves ALL business rules from the original prompt-builder.service.ts
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { URUGUAY_UTC_OFFSET_MS, FREIGHT_STATUS_SHORT, APP_URL } from '../core/constants';
import { resolveActiveRole, resolveCompanyTypes, hasType, sanitizeForPrompt, isProducerMembership } from '../utils/ai-utils';
import { buildIdentitySection } from './sections/identity';
import { buildUserContextSection } from './sections/user-context';
import { buildFreightRulesSection } from './sections/freight-rules';
import { buildAssignmentRulesSection } from './sections/assignment-rules';
import { buildFleetRulesSection } from './sections/fleet-rules';
import { buildWhatsappFormatSection } from './sections/whatsapp-format';
import { buildSafetyRulesSection } from './sections/safety-rules';

@Injectable()
export class PromptBuilderService {
  private readonly logger = new Logger(PromptBuilderService.name);

  constructor(private prisma: PrismaService) {}

  private resolveProducerCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isProducerMembership(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find((m: any) => m.active === true && isProducerMembership(m));
      if (pm) return pm.companyId;
    }
    if (resolveCompanyTypes(user.company).includes('producer')) return user.companyId;
    return null;
  }

  async build(user: any, companyType: string, isWeb = false, plantAccessMap?: Map<string, string>): Promise<string> {
    const name = sanitizeForPrompt(user.name?.split(' ')[0] || 'usuario');
    const nowUY = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS);
    const today = nowUY.toISOString().split('T')[0];

    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = activeMemberships.find((m: any) => m.companyId === activeCoId);
    const activeCoName = sanitizeForPrompt(activeMem?.company?.name || user.company?.name || '');
    const hasOwnFleet = activeMem?.company?.hasInternalFleet || (!activeMem && user.company?.hasInternalFleet);
    const ownFleet = !!hasOwnFleet;
    const isAutonomousDriver = !!(activeMem?.company?.autonomousDriverEnabled || (!activeMem && user.company?.autonomousDriverEnabled));
    const { isChofer, isAdmin, userRole } = resolveActiveRole(user);

    // Resolve plant access levels
    let readonlyPlants: string[] = [];
    let operatorPlants: string[] = [];
    if (plantAccessMap && plantAccessMap.size > 0) {
      try {
        const plantIds = Array.from(plantAccessMap.keys());
        const companies = await this.prisma.company.findMany({ where: { id: { in: plantIds } }, select: { id: true, name: true } });
        const nameMap = new Map(companies.map(c => [c.id, c.name]));
        for (const [plantId, level] of plantAccessMap) {
          const pName = nameMap.get(plantId) || plantId;
          if (level === 'READONLY') readonlyPlants.push(pName);
          else if (level === 'OPERATOR') operatorPlants.push(pName);
        }
      } catch { /* ignore */ }
    }

    const allReadonly = readonlyPlants.length > 0 && operatorPlants.length === 0;
    const canCreateFreight = !isChofer && !allReadonly && (hasType(companyType, 'producer') || hasType(companyType, 'plant'));
    const canManageFleet = !isChofer && !allReadonly && (hasType(companyType, 'transporter') || ownFleet);
    const canAssignTransport = !isChofer && !allReadonly && (hasType(companyType, 'plant') || hasType(companyType, 'transporter'));

    // Build sections
    const identity = buildIdentitySection(name, activeCoName, companyType, today, userRole, isChofer, isAdmin, ownFleet, activeMemberships.length, readonlyPlants, operatorPlants, isChofer && isAutonomousDriver);
    const userContext = buildUserContextSection(isWeb, isChofer, isAdmin);
    const freightRules = canCreateFreight ? buildFreightRulesSection(isWeb) : '';
    const assignmentRules = canAssignTransport ? buildAssignmentRulesSection() : '';
    const fleetRules = canManageFleet ? buildFleetRulesSection() : '';
    const whatsappFormat = buildWhatsappFormatSection(isWeb, isAdmin, APP_URL, canManageFleet, canCreateFreight, isChofer && isAutonomousDriver);
    const safetyRules = buildSafetyRulesSection(isWeb);

    // Proactive data
    const isAutoChofer = isChofer && isAutonomousDriver;
    let proactiveLines: string[] = [];
    try {
      if (activeCoId) {
        // Skip fields/lots/plant-access queries for autonomous chofer (they don't need them)
        if (hasType(companyType, 'producer') && !isAutoChofer) {
          const producerCoId = this.resolveProducerCompanyId(user);
          if (producerCoId) {
            const [fields, lotCount] = await Promise.all([
              this.prisma.field.findMany({ where: { companyId: producerCoId, active: true }, select: { id: true, name: true, lots: { where: { active: true }, select: { name: true }, take: 5 } }, take: 5 }),
              this.prisma.lot.count({ where: { companyId: producerCoId, active: true } }),
            ]);
            proactiveLines.push(`Campos: ${fields.length} | Lotes: ${lotCount}`);
            if (fields.length === 1) {
              const f = fields[0];
              const lotNames = f.lots.map((l: any) => l.name).join(', ');
              proactiveLines.push(`Campo unico: ${f.name}${lotNames ? ` (lotes: ${lotNames})` : ' (sin lotes)'}`);
            }
            const accesses = await this.prisma.plantProducerAccess.findMany({ where: { producerCompanyId: producerCoId, active: true }, select: { plantCompany: { select: { name: true } } }, take: 5 });
            if (accesses.length > 0) {
              const plantNames = accesses.map(a => a.plantCompany?.name).filter(Boolean).slice(0, 3);
              proactiveLines.push(`Plantas habilitadas: ${plantNames.join(', ')}`);
            }
          }
        }
        const recentFreights = await this.prisma.freight.findMany({
          where: { participantCompanyIds: { has: activeCoId }, status: { notIn: ['canceled', 'draft'] } },
          select: { code: true, status: true, items: { select: { grain: true }, take: 1 } },
          orderBy: { createdAt: 'desc' }, take: 3,
        });
        if (recentFreights.length > 0) {
          const fList = recentFreights.map(f => `${f.code} (${FREIGHT_STATUS_SHORT[f.status] || f.status})`).join(', ');
          proactiveLines.push(`Ultimos fletes: ${fList}`);
        }
        if (hasOwnFleet) {
          const truckCount = await this.prisma.truck.count({ where: { companyId: activeCoId, active: true } });
          proactiveLines.push(`Flota propia: ${truckCount} camion(es)`);
        }
      }
    } catch (e: any) { this.logger.warn(`Proactive data failed: ${e.message}`); }

    // Assemble prompt
    let prompt = [identity, userContext, freightRules, assignmentRules, fleetRules, whatsappFormat, safetyRules].filter(Boolean).join('\n\n');
    if (proactiveLines.length > 0) {
      prompt += `\n\n<proactive_data>\nDATOS DEL USUARIO (pre-cargados, NO repetir al usuario salvo que pregunte):\n${proactiveLines.join('\n')}\nAUTO-SELECCION: Si hay una sola opcion (1 campo, 1 lote, 1 planta, 1 camion), seleccionarla automaticamente.\n</proactive_data>`;
    }

    return prompt;
  }
}
