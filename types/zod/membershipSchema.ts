import { z } from 'zod';

export const membershipSchema = z.object({
  brandId: z.string().nullable().optional().default(null),
  businessId: z.string().nullable().optional().default(null),
  roles: z.array(z.string()).default([])
});