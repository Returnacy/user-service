import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveDomainFromRequest } from '@/utils/domainMapping.js';

// Roles allowed to administer a brand's team (GET /team, PATCH /team/:userId,
// GET /team/search). STAFF/MANAGER/USER are intentionally excluded.
const TEAM_ADMIN_ROLES = new Set(['BRAND_MANAGER', 'ADMIN']);

export type TeamContext = {
  brandId: string;
  callerUserId: string;
  callerRole: string;
};

type TeamContextResult =
  | { ok: true; context: TeamContext }
  | { ok: false; response: ServiceResponse<{ error: string; message?: string }> };

// Shared guard for the team endpoints: authenticates the caller, resolves the
// brand from the request's domain context, and verifies the caller holds a
// BRAND_MANAGER or ADMIN membership on that brand.
//   - no authenticated caller            -> 401
//   - domain resolves to no brand        -> 400
//   - caller lacks BRAND_MANAGER/ADMIN   -> 403
export async function resolveTeamContext(request: FastifyRequest): Promise<TeamContextResult> {
  const auth = (request as any).auth as { sub?: string } | undefined;
  if (!auth?.sub) {
    return { ok: false, response: { statusCode: 401, body: { error: 'UNAUTHENTICATED' } } };
  }

  const domain = await resolveDomainFromRequest(request.headers);
  const brandId = domain?.brandId ?? null;
  if (!brandId) {
    return { ok: false, response: { statusCode: 400, body: { error: 'BRAND_NOT_RESOLVED' } } };
  }

  const repository = (request.server as any).repository as any;
  const caller = await repository.findUserByKeycloakSub(auth.sub);
  if (!caller) {
    return { ok: false, response: { statusCode: 403, body: { error: 'FORBIDDEN' } } };
  }

  const membership = await repository.getMembershipByBrand(caller.id, brandId);
  const callerRole = membership?.role ? String(membership.role) : null;
  if (!callerRole || !TEAM_ADMIN_ROLES.has(callerRole)) {
    return { ok: false, response: { statusCode: 403, body: { error: 'FORBIDDEN' } } };
  }

  return { ok: true, context: { brandId, callerUserId: caller.id, callerRole } };
}
