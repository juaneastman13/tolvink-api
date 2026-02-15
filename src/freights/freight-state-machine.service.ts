import { Injectable, BadRequestException } from '@nestjs/common';
import { FreightStatus } from '@prisma/client';

// =====================================================================
// TOLVINK — Freight State Machine
// Single source of truth for all state transitions
// Frontend must mirror these rules exactly
// =====================================================================

type Transition = {
  to: FreightStatus;
  requiredRole?: string[];       // company types that can trigger
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
    { to: FreightStatus.accepted, requiredRole: ['transporter'] },
    {
      to: FreightStatus.pending_assignment,
      requiredRole: ['transporter'],
      requiresReason: true,
      validate: () => null, // rejection — handled via assignment respond
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
    { to: FreightStatus.finished, requiredRole: ['transporter', 'plant'] },
    // CANNOT cancel when in_progress — this is a business rule
  ],
  finished: [],   // terminal
  canceled: [],   // terminal
};

@Injectable()
export class FreightStateMachine {

  getAllowedTransitions(currentStatus: FreightStatus): FreightStatus[] {
    return (TRANSITIONS[currentStatus] || []).map(t => t.to);
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

    // Check role permission
    if (transition.requiredRole && companyType) {
      if (!transition.requiredRole.includes(companyType)) {
        throw new BadRequestException(
          `Solo ${transition.requiredRole.join('/')} puede ejecutar esta transición`,
        );
      }
    }

    // Check required reason
    if (transition.requiresReason && (!reason || reason.trim().length === 0)) {
      throw new BadRequestException('Motivo obligatorio para esta acción');
    }

    // Custom validation
    if (transition.validate) {
      const error = transition.validate({ reason });
      if (error) throw new BadRequestException(error);
    }
  }
}
