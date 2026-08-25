import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { fetchDomainBusinesses, resolveDomainFromRequest } from '@/utils/domainMapping.js';
import { signAccessToken, type AccessTokenClaims } from '@/utils/selfIssuedJwt.js';
import { findMembershipInBrand } from '@/utils/tenantGuard.js';

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

/**
 * Accept a client-proposed location only if it demonstrably belongs to `brandId`.
 *
 * Two sources, because neither alone covers the live data: the caller's own
 * membership (which is how Che Pizza's Lissaro is known at all — it is absent
 * from domain-mapping.json), and the domain-mapper entries (which cover a
 * location nobody is a member of yet).
 *
 * Unverifiable proposal → **null**, i.e. no businessId claim at all, exactly as
 * docs/SSO-PM-CONTRACT.md §4 states. Substituting the membership's own location
 * would be worse than saying nothing: a Lissaro staff member asking for Lissaro
 * (unresolvable, since Lissaro is not in domain-mapping.json and may not be
 * their membership row) would receive a token asserting Taggi, and PM — which
 * is specified to prefer the claim over the URL fragment — would silently open
 * the chiusura for the wrong pizzeria. Omitting the claim lets PM fall back to
 * `loc`, which is safe now that brandId is enforced.
 */
async function resolveBusinessForBrand(
  proposed: string,
  brandId: string,
  membershipBusinessId: string | null,
): Promise<string | null> {
  if (membershipBusinessId && proposed === membershipBusinessId) return proposed;
  try {
    const entries = await fetchDomainBusinesses();
    const match = entries.find((entry) => entry.businessId === proposed && entry.brandId === brandId);
    if (match) return proposed;
  } catch {
    // mapper unavailable — cannot verify, so cannot assert
  }
  return null;
}

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

    // Legacy rows (businessId set, brandId NULL) count as membership of this
    // brand, exactly as they do for stamping — otherwise the same staff member
    // can stamp all evening and not open the chiusura.
    const membership = await findMembershipInBrand(request, user.id, brandId);
    const role = membership?.role ? String(membership.role) : null;
    if (!role || !PM_HANDOFF_ROLES.has(role)) {
      return { statusCode: 403, body: { error: 'FORBIDDEN' } };
    }

    // Which location this handoff is for. The client may propose one (the
    // staff member's daily pick — Taggi vs Lissaro), but it is only put in the
    // token if we can tie it to this brand. An unverifiable proposal is
    // dropped rather than echoed: see docs/SSO-PM-CONTRACT.md §4.
    const proposedBusinessId = typeof (request.body as any)?.businessId === 'string'
      ? String((request.body as any).businessId)
      : null;
    const businessId = proposedBusinessId
      ? await resolveBusinessForBrand(proposedBusinessId, brandId, membership?.businessId ?? null)
      : (membership?.businessId ?? null);

    // Short-lived (60s), audience-scoped access token. No refresh token and no
    // jti store: the 60s TTL is the accepted replay bound, so a captured token
    // is unusable within a minute and re-issuing is a single cheap call.
    //
    // `brandId` is the claim that makes this token tenant-bound. Without it any
    // PizzeriaManager on the same issuer accepted any tenant's staff, and the
    // target location came from the URL fragment — attacker-controlled.
    const extraClaims: Record<string, unknown> = { membershipRole: role, brandId };
    if (businessId) extraClaims.businessId = businessId;

    const token = await signAccessToken(buildClaims(user), {
      audience: PM_HANDOFF_AUDIENCE,
      ttlSeconds: PM_HANDOFF_TTL_SECONDS,
      extraClaims,
    });

    return { statusCode: 200, body: { token, expiresIn: PM_HANDOFF_TTL_SECONDS } };
  } catch (error) {
    request.log.error({ err: error }, 'PM_HANDOFF_FAILED');
    return { statusCode: 500, body: { error: 'PM_HANDOFF_FAILED' } };
  }
}
