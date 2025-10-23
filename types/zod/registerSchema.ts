import { z } from 'zod';
import { membershipSchema } from './membershipSchema.js';

export const registerSchema = z.object({
  email: z.string(),
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