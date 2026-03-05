import { Injectable, BadRequestException } from '@nestjs/common';
import { FreightStatus } from '@prisma/client';

// TripStatus enum not available locally (prisma generate EPERM) — use string literals
// Railway regenerates on deploy
type TripStatus = 'pending' | 'accepted' | 'in_progress' | 'loaded' | 'finished' | 'canceled';

// =====================================================================
// TOLVINK — Freight State Machine v2
// Added: loaded state, cross-confirmation flow
// 
// FLOW:
//   draft → pending_assignment → assigned → accepted → in_progress → loaded → finished
//                                                                          ↘ canceled
//
// CROSS-CONFIRMATIONS:
//   in_progress → loaded:   transportista confirma carga
//   loaded:                 productor confirma carga (optional enrichment)
//   loaded → finished:      transportista + planta ambos confirman entrega
//
// BREAKING CHANGE: in_progress → finished ya NO es directo.
//   Debe pasar por loaded primero.
// =====================================================================

type Transition = {
  to: FreightStatus;
  requiredRole?: string[];
  requiresReason?: boolean;
  validate?: (context: any) => string | null;
};

const TRANSITIONS: Record<FreightStatus, Transition[]> = {
  draft: [
    { to: FreightStatus.pending_assignment },
    { to: FreightStatus.canceled, requiresReason: true },
  ],
  pending_assignment: [
    { to: FreightStatus.assigned, requiredRole: ['plant'] },
    { to: FreightStatus.canceled, requiresReason: true },
  ],
  assigned: [
    { to: FreightStatus.accepted, requiredRole: ['transporter', 'plant'] },
    {
      to: FreightStatus.pending_assignment,
      requiredRole: ['transporter'],
      requiresReason: true,
      validate: () => null,
    },
    { to: FreightStatus.canceled, requiresReason: true },
  ],
  accepted: [
    { to: FreightStatus.in_progress, requiredRole: ['transporter'] },
    {
      to: FreightStatus.pending_assignment,
      requiredRole: ['transporter'],
      requiresReason: true,
    },
    { to: FreightStatus.canceled, requiresReason: true },
  ],
  in_progress: [
    // CHANGED: in_progress → loaded (transportista confirms load)
    { to: FreightStatus.loaded, requiredRole: ['transporter'] },
    // REMOVED: in_progress → finished (must go through loaded now)
    // CANNOT cancel when in_progress — business rule maintained
  ],
  loaded: [
    // loaded → finished: requires cross-confirmation (handled in service layer)
    { to: FreightStatus.finished, requiredRole: ['transporter', 'plant'] },
    // CANNOT cancel when loaded — cargo is on the truck
  ],
  finished: [],   // terminal
  canceled: [],   // terminal
};

// ======================== TRIP-LEVEL TRANSITIONS (v6.0) ================
const TRIP_TRANSITIONS: Record<TripStatus, { to: TripStatus; requiredRole?: string[] }[]> = {
  pending:     [{ to: 'accepted' }, { to: 'canceled' }],
  accepted:    [{ to: 'in_progress' }, { to: 'canceled' }],
  in_progress: [{ to: 'loaded' }],
  loaded:      [{ to: 'finished' }],
  finished:    [],
  canceled:    [],
};

@Injectable()
export class FreightStateMachine {

  getAllowedTransitions(currentStatus: FreightStatus): FreightStatus[] {
    return (TRANSITIONS[currentStatus] || []).map(t => t.to);
  }

  validateTripTransition(currentStatus: TripStatus, newStatus: TripStatus): void {
    const allowed = TRIP_TRANSITIONS[currentStatus];
    if (!allowed || allowed.length === 0) {
      throw new BadRequestException(`El viaje en estado "${currentStatus}" no admite más transiciones`);
    }
    const transition = allowed.find(t => t.to === newStatus);
    if (!transition) {
      const valid = allowed.map(t => t.to).join(', ');
      throw new BadRequestException(`Transición de viaje inválida: ${currentStatus} → ${newStatus}. Permitidas: ${valid}`);
    }
  }

  validateTransition(
    currentStatus: FreightStatus,
    newStatus: FreightStatus,
    companyType?: string,
    reason?: string,
  ): void {
    const allowed = TRANSITIONS[currentStatus];
    if (!allowed || allowed.length === 0) {
      throw new BadRequestException(
        `El flete en estado "${currentStatus}" no admite más transiciones`,
      );
    }

    const transition = allowed.find(t => t.to === newStatus);
    if (!transition) {
      const valid = allowed.map(t => t.to).join(', ');
      throw new BadRequestException(
        `Transición inválida: ${currentStatus} → ${newStatus}. Permitidas: ${valid}`,
      );
    }

    if (transition.requiredRole && companyType) {
      if (!transition.requiredRole.includes(companyType)) {
        throw new BadRequestException(
          `Solo ${transition.requiredRole.join('/')} puede ejecutar esta transición`,
        );
      }
    }

    if (transition.requiresReason && (!reason || reason.trim().length === 0)) {
      throw new BadRequestException('Motivo obligatorio para esta acción');
    }

    if (transition.validate) {
      const error = transition.validate({ reason });
      if (error) throw new BadRequestException(error);
    }
  }
}
