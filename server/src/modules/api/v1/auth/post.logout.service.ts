import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';

const logoutSchema = z.object({ refreshToken: z.string().min(1).optional() });

type LogoutResponse = { ok: true } | { error: string };

export async function postLogoutService(request: FastifyRequest): Promise<ServiceResponse<LogoutResponse>> {
  // Phase 2.6: client-side logout. Self-issued refresh tokens have a finite
  // TTL and aren't tracked server-side; the previous Keycloak logout call
  // would hang ~30s after auth-service was removed. Frontend clears its
  // tokens locally regardless of this response.
  try {
    logoutSchema.parse(request.body ?? {});
  } catch {
    // ignore body validation issues — logout is best-effort.
  }
  return { statusCode: 200, body: { ok: true } };
}
