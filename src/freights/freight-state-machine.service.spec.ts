import { BadRequestException } from '@nestjs/common';
import { FreightStateMachine } from './freight-state-machine.service';

// Mock FreightStatus enum since @prisma/client may not be generated locally
const FreightStatus = {
  draft: 'draft',
  pending_assignment: 'pending_assignment',
  assigned: 'assigned',
  accepted: 'accepted',
  in_progress: 'in_progress',
  loaded: 'loaded',
  finished: 'finished',
  canceled: 'canceled',
} as any;

jest.mock('@prisma/client', () => ({
  FreightStatus: {
    draft: 'draft',
    pending_assignment: 'pending_assignment',
    assigned: 'assigned',
    accepted: 'accepted',
    in_progress: 'in_progress',
    loaded: 'loaded',
    finished: 'finished',
    canceled: 'canceled',
  },
}));

describe('FreightStateMachine', () => {
  let sm: FreightStateMachine;

  beforeEach(() => {
    sm = new FreightStateMachine();
  });

  describe('getAllowedTransitions', () => {
    it('draft → pending_assignment, canceled', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.draft);
      expect(allowed).toContain('pending_assignment');
      expect(allowed).toContain('canceled');
    });

    it('pending_assignment → assigned, canceled', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.pending_assignment);
      expect(allowed).toContain('assigned');
      expect(allowed).toContain('canceled');
    });

    it('assigned → accepted, pending_assignment, canceled', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.assigned);
      expect(allowed).toContain('accepted');
      expect(allowed).toContain('pending_assignment');
      expect(allowed).toContain('canceled');
    });

    it('accepted → in_progress, pending_assignment, canceled', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.accepted);
      expect(allowed).toContain('in_progress');
      expect(allowed).toContain('pending_assignment');
      expect(allowed).toContain('canceled');
    });

    it('in_progress → loaded only', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.in_progress);
      expect(allowed).toEqual(['loaded']);
    });

    it('loaded → finished only', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.loaded);
      expect(allowed).toEqual(['finished']);
    });

    it('finished is terminal', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.finished);
      expect(allowed).toEqual([]);
    });

    it('canceled is terminal', () => {
      const allowed = sm.getAllowedTransitions(FreightStatus.canceled);
      expect(allowed).toEqual([]);
    });
  });

  describe('validateTransition', () => {
    it('allows valid transitions', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.pending_assignment, FreightStatus.assigned, 'plant'),
      ).not.toThrow();
    });

    it('throws on invalid transition', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.draft, FreightStatus.finished),
      ).toThrow(BadRequestException);
    });

    it('throws when terminal state', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.finished, FreightStatus.draft),
      ).toThrow(BadRequestException);
    });

    it('throws when wrong role', () => {
      // pending_assignment → assigned requires plant
      expect(() =>
        sm.validateTransition(FreightStatus.pending_assignment, FreightStatus.assigned, 'transporter'),
      ).toThrow(BadRequestException);
    });

    it('allows correct role', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.assigned, FreightStatus.accepted, 'transporter'),
      ).not.toThrow();
    });

    it('requires reason for cancellation', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.draft, FreightStatus.canceled, undefined, ''),
      ).toThrow(BadRequestException);

      expect(() =>
        sm.validateTransition(FreightStatus.draft, FreightStatus.canceled, undefined, 'Motivo válido'),
      ).not.toThrow();
    });

    it('in_progress cannot cancel (no cancel transition)', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.in_progress, FreightStatus.canceled),
      ).toThrow(BadRequestException);
    });

    it('loaded cannot cancel', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.loaded, FreightStatus.canceled),
      ).toThrow(BadRequestException);
    });

    it('in_progress cannot go directly to finished', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.in_progress, FreightStatus.finished),
      ).toThrow(BadRequestException);
    });

    it('accepted → in_progress requires transporter', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.accepted, FreightStatus.in_progress, 'producer'),
      ).toThrow(BadRequestException);

      expect(() =>
        sm.validateTransition(FreightStatus.accepted, FreightStatus.in_progress, 'transporter'),
      ).not.toThrow();
    });

    it('in_progress → loaded requires transporter', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.in_progress, FreightStatus.loaded, 'plant'),
      ).toThrow(BadRequestException);

      expect(() =>
        sm.validateTransition(FreightStatus.in_progress, FreightStatus.loaded, 'transporter'),
      ).not.toThrow();
    });

    it('loaded → finished requires transporter or plant', () => {
      expect(() =>
        sm.validateTransition(FreightStatus.loaded, FreightStatus.finished, 'transporter'),
      ).not.toThrow();

      expect(() =>
        sm.validateTransition(FreightStatus.loaded, FreightStatus.finished, 'plant'),
      ).not.toThrow();

      expect(() =>
        sm.validateTransition(FreightStatus.loaded, FreightStatus.finished, 'producer'),
      ).toThrow(BadRequestException);
    });
  });
});
