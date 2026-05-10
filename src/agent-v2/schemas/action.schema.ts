import { z } from 'zod';

export const ActionNameSchema = z.enum([
  'create_freight',
  'update_freight',
  'cancel_freight',
  'assign_transport_company',
  'assign_driver_and_truck',
  'confirm_loaded',
  'confirm_arrival',
  'finish_freight',
  'generate_map_link',
  'attach_document',
]);

export type AgentActionName = z.infer<typeof ActionNameSchema>;

export const PendingActionSchema = z.object({
  action: ActionNameSchema,
  payload: z.record(z.string(), z.unknown()),
  summary: z.string(),
  requiresConfirmation: z.boolean().default(true),
  auditId: z.string().optional(),
  createdAt: z.string().optional(),
});

export type PendingAction = z.infer<typeof PendingActionSchema>;

// Pending confirmations expire after 30 minutes; a "si" arriving later
// must NOT execute the stale action — checked in resolveConfirmationNode.
export const PENDING_ACTION_TTL_MS = 30 * 60 * 1000;

