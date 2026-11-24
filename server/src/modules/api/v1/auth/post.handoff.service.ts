import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveDomainFromRequest } from '@/utils/domainMapping.js';
import { getHandoffTargets } from '@/utils/handoffTargets.js';
import { signAccessToken, type AccessTokenClaims } from '@/utils/selfIssuedJwt.js';
import { findMembershipInBrand } from '@/utils/tenantGuard.js';

const HANDOFF_TTL_SECONDS = 60;

type HandoffResponse = { token: string; expiresIn: number; url: string } | { error: string };

const UNKNOWN_TARGET = { statusCode: 404, body: { error: 'UNKNOWN_HANDOFF_TARGET' } } as const;
const FORBIDDEN = { statusCode: 403, body: { error: 'FORBIDDEN' } } as const;

/**
 * Hand a logged-in member of the request's brand off to an external service of
 * that same brand (HANDOFF_TARGETS). See docs/SSO-HANDOFF-CONTRACT.md.
 *
 * The generic sibling of /pm-handoff, for every role including plain customers.
 * The token leaves the platform, so it carries the minimum the receiver needs to
 * open its own session: who (sub, given_name), for which tenant (brandId) and
 * with which role — never an email or a surname.
 */
export async function postHandoffService(request: FastifyRequest): Promise<ServiceResponse<HandoffResponse>> {
  const auth = (request as any).auth as { sub?: string } | undefined;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const key = (request.body as any)?.target;
    const target = typeof key === 'string' ? getHandoffTargets(request.log).get(key) : undefined;
    if (!target) return UNKNOWN_TARGET;

    // The brand comes from the request host, never from the body. A target of
    // brand A is invisible from brand B's app — and from a host that resolves
    // to no brand at all — so the 404 is the same as for a key that does not
    // exist: no oracle for which targets other tenants have.
    const domain = await resolveDomainFromRequest(request.headers);
    const brandId = domain?.brandId ?? null;
    if (!brandId || brandId !== target.brandId) return UNKNOWN_TARGET;

    const repository = (request.server as any).repository as any;
    const user = await repository.findUserByKeycloakSub(auth.sub);
    if (!user) return FORBIDDEN;

    // The core property: an account that exists only under another brand never
    // gets a token for this one. Legacy rows (businessId of this brand, brandId
    // NULL) count, as they do everywhere else.
    const membership = await findMembershipInBrand(request, user.id, brandId);
    const role = membership?.role ? String(membership.role).toUpperCase() : null;
    if (!role || (target.roles && !target.roles.has(role))) return FORBIDDEN;

    // azp is the target, not the default 'user-service': first-party audience
    // gates accept a token whose aud OR azp is allowed, so the default would
    // make this token usable against our own APIs by whoever receives it.
    const claims: AccessTokenClaims = { sub: user.keycloakSub, azp: target.audience, scope: 'openid' };
    if (user.name) claims.given_name = user.name;

    const extraClaims: Record<string, unknown> = { brandId, membershipRole: role };
    if (membership.businessId) extraClaims.businessId = membership.businessId;

    // signAccessToken sets a random jti, so receivers can enforce single use.
    const token = await signAccessToken(claims, {
      audience: target.audience,
      ttlSeconds: HANDOFF_TTL_SECONDS,
      extraClaims,
    });

    return { statusCode: 200, body: { token, expiresIn: HANDOFF_TTL_SECONDS, url: target.url } };
  } catch (error) {
    request.log.error({ err: error }, 'HANDOFF_FAILED');
    return { statusCode: 500, body: { error: 'HANDOFF_FAILED' } };
  }
}
