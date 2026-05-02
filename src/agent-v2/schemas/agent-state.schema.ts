import { Annotation } from '@langchain/langgraph';
import { z } from 'zod';
import { IntentSchema } from './intent.schema';
import { PendingActionSchema } from './action.schema';
import { CreateFreightSlotsSchema } from './freight.schema';

export const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().optional(),
  source: z.enum(['whatsapp_location', 'map_picker', 'backend_known_location']),
  capturedAt: z.string(),
  capturedByUserId: z.string(),
});

export type AgentLocation = z.infer<typeof LocationSchema>;

export const AgentStateSchema = z.object({
  channel: z.enum(['whatsapp', 'web']).default('whatsapp'),
  userId: z.string(),
  phone: z.string(),
  sessionId: z.string().optional(),
  activeCompanyId: z.string().nullable().optional(),
  activeCompanyType: z.string().nullable().optional(),
  activeRole: z.string().nullable().optional(),
  membershipActive: z.boolean().nullable().optional(),
  currentIntent: IntentSchema.optional(),
  currentFlow: z.string().nullable().optional(),
  currentStep: z.string().nullable().optional(),
  awaitingSlot: z.string().nullable().optional(),
  slots: z.record(z.string(), z.unknown()).default({}),
  originText: z.string().nullable().optional(),
  destinationText: z.string().nullable().optional(),
  originLocation: LocationSchema.nullable().optional(),
  destinationLocation: LocationSchema.nullable().optional(),
  pendingLocationRequest: z.boolean().default(false),
  locationRequestToken: z.string().nullable().optional(),
  locationRequestType: z.enum(['origin', 'destination', 'interest_point']).nullable().optional(),
  locationCapturedAt: z.string().nullable().optional(),
  locationCapturedByUserId: z.string().nullable().optional(),
  locationCapturedForCompanyId: z.string().nullable().optional(),
  activeFreightCode: z.string().nullable().optional(),
  pendingAction: PendingActionSchema.nullable().optional(),
  pendingConfirmation: z.boolean().default(false),
  executedActionId: z.string().nullable().optional(),
  executedResult: z.record(z.string(), z.unknown()).nullable().optional(),
  lastUserMessage: z.string().default(''),
  response: z.string().optional(),
  shouldPause: z.boolean().default(false),
  shouldPersist: z.boolean().default(true),
  audit: z.array(z.record(z.string(), z.unknown())).default([]),
  auditTrail: z.array(z.record(z.string(), z.unknown())).default([]),
  nodeHistory: z.array(z.record(z.string(), z.unknown())).default([]),
  toolCalls: z.array(z.record(z.string(), z.unknown())).default([]),
  errors: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentStateAnnotation = Annotation.Root({
  channel: Annotation<AgentState['channel']>(),
  userId: Annotation<string>(),
  phone: Annotation<string>(),
  sessionId: Annotation<string | undefined>(),
  activeCompanyId: Annotation<string | null | undefined>(),
  activeCompanyType: Annotation<string | null | undefined>(),
  activeRole: Annotation<string | null | undefined>(),
  membershipActive: Annotation<boolean | null | undefined>(),
  currentIntent: Annotation<AgentState['currentIntent']>(),
  currentFlow: Annotation<string | null | undefined>(),
  currentStep: Annotation<string | null | undefined>(),
  awaitingSlot: Annotation<string | null | undefined>(),
  slots: Annotation<Record<string, unknown>>(),
  originText: Annotation<string | null | undefined>(),
  destinationText: Annotation<string | null | undefined>(),
  originLocation: Annotation<AgentLocation | null | undefined>(),
  destinationLocation: Annotation<AgentLocation | null | undefined>(),
  pendingLocationRequest: Annotation<boolean>(),
  locationRequestToken: Annotation<string | null | undefined>(),
  locationRequestType: Annotation<'origin' | 'destination' | 'interest_point' | null | undefined>(),
  locationCapturedAt: Annotation<string | null | undefined>(),
  locationCapturedByUserId: Annotation<string | null | undefined>(),
  locationCapturedForCompanyId: Annotation<string | null | undefined>(),
  activeFreightCode: Annotation<string | null | undefined>(),
  pendingAction: Annotation<AgentState['pendingAction']>(),
  pendingConfirmation: Annotation<boolean>(),
  executedActionId: Annotation<string | null | undefined>(),
  executedResult: Annotation<Record<string, unknown> | null | undefined>(),
  lastUserMessage: Annotation<string>(),
  response: Annotation<string | undefined>(),
  shouldPause: Annotation<boolean>(),
  shouldPersist: Annotation<boolean>(),
  audit: Annotation<Array<Record<string, unknown>>>(),
  auditTrail: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => [...(left || []), ...(right || [])].slice(-200),
    default: () => [],
  }),
  nodeHistory: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => [...(left || []), ...(right || [])].slice(-200),
    default: () => [],
  }),
  toolCalls: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => [...(left || []), ...(right || [])].slice(-100),
    default: () => [],
  }),
  errors: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => [...(left || []), ...(right || [])].slice(-50),
    default: () => [],
  }),
});

export const parseCreateFreightSlots = (slots: Record<string, unknown>) =>
  CreateFreightSlotsSchema.partial().parse(slots);
