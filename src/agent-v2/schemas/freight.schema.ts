import { z } from 'zod';

export const CreateFreightSlotsSchema = z.object({
  product: z.string().trim().min(1).optional(),
  origin: z.string().trim().min(1).optional(),
  destination: z.string().trim().min(1).optional(),
  date: z.string().trim().min(1).optional(),
  time: z.string().trim().min(1).optional(),
  truckCount: z.number().int().min(1).max(50).optional(),
  observations: z.string().trim().max(1000).optional(),
});

export type CreateFreightSlots = z.infer<typeof CreateFreightSlotsSchema>;

export const CreateFreightSlotsPatchSchema = CreateFreightSlotsSchema.partial();
