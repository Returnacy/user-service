import { z } from 'zod';

export const membershipSchema = z.object({
  brandId: z.string().nullable().optional().default(null),
  businessId: z.string().nullable().optional().default(null),
  roles: z.array(z.string()).default([])
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
  name: z.string(),
  surname: z.string(),
  birthday: z.string(),
  gender: z.string().optional(),
  // terms
  acceptTermsOfService: z.boolean().default(false),
  acceptPrivacyPolicy: z.boolean().default(false),
  acceptMarketing: z.boolean().default(false),
  // initial membership to assign in Keycloak
  membership: membershipSchema.optional()
});

export type RegisterInput = z.infer<typeof registerSchema>;
