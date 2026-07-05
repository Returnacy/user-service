import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveDomainFromRequest } from '@/utils/domainMapping.js';
import { signAccessToken, type AccessTokenClaims } from '@/utils/selfIssuedJwt.js';

// Roles allowed to obtain a pizzeria-manager SSO handoff token. Broader than the
// team-admin set: any staff member (and up) may open pizzeria-manager.
const PM_HANDOFF_ROLES = new Set(['STAFF', 'MANAGER', 'BRAND_MANAGER', 'ADMIN']);

const PM_HANDOFF_AUDIENCE = 'pizzeria-manager';
const PM_HANDOFF_TTL_SECONDS = 60;

function buildClaims(user: { keycloakSub: string; email: string; name?: string | null; surname?: string | null }): AccessTokenClaims {
  const fullName = `${user.name ?? ''} ${user.surname ?? ''}`.trim();
  const claims: AccessTokenClaims = {
    sub: user.keycloakSub,
    email: user.email,
    email_verified: true,
    preferred_username: user.email,
  };
  if (user.name) claims.given_name = user.name;
  if (user.surname) claims.family_name = user.surname;
  if (fullName) claims.name = fullName;
  return claims;
}

type PmHandoffResponse = { token: string; expiresIn: number } | { error: string };

export async function postPmHandoffService(request: FastifyRequest): Promise<ServiceResponse<PmHandoffResponse>> {
  const auth = (request as any).auth as { sub?: string } | undefined;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const domain = await resolveDomainFromRequest(request.headers);
    const brandId = domain?.brandId ?? null;
    if (!brandId) {
      // No brand context => no qualifying membership can exist => forbidden.
      return { statusCode: 403, body: { error: 'FORBIDDEN' } };
    }

    const repository = (request.server as any).repository as any;
    const user = await repository.findUserByKeycloakSub(auth.sub);
    if (!user) {
      return { statusCode: 403, body: { error: 'FORBIDDEN' } };
    }

    const membership = await repository.getMembershipByBrand(user.id, brandId);
    const role = membership?.role ? String(membership.role) : null;
    if (!role || !PM_HANDOFF_ROLES.has(role)) {
      return { statusCode: 403, body: { error: 'FORBIDDEN' } };
    }

    // Short-lived (60s), audience-scoped access token. No refresh token and no
    // jti store: the 60s TTL is the accepted replay bound, so a captured token
    // is unusable within a minute and re-issuing is a single cheap call.
    const token = await signAccessToken(buildClaims(user), {
      audience: PM_HANDOFF_AUDIENCE,
      ttlSeconds: PM_HANDOFF_TTL_SECONDS,
      extraClaims: { membershipRole: role },
    });

    return { statusCode: 200, body: { token, expiresIn: PM_HANDOFF_TTL_SECONDS } };
  } catch (error) {
    request.log.error({ err: error }, 'PM_HANDOFF_FAILED');
    return { statusCode: 500, body: { error: 'PM_HANDOFF_FAILED' } };
  }
}
