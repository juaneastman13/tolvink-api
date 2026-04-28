import { z } from 'zod';

export const IntentSchema = z.enum([
  'greet',
  'help',
  'query_freights',
  'create_freight',
  'assign_transport_company',
  'assign_driver_and_truck',
  'confirm_loaded',
  'confirm_arrival',
  'finish_freight',
  'cancel_freight',
  'share_map',
  'attach_document',
  'switch_company',
  'unknown',
]);

export type AgentIntent = z.infer<typeof IntentSchema>;

