import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { isPlatformAdmin, requireServiceForTenant, resolveBrandForBusiness } from '@/utils/tenantGuard.js';

type MembershipInput = { brandId: string | null; businessId: string | null; roles: string[] };

type PatchMembershipsResponse = { ok: true } | { error: string; message?: string };

export async function patchMembershipsService(
  request: FastifyRequest<{ Params: { userId: string }; Body: { memberships?: MembershipInput[] } }>
): Promise<ServiceResponse<PatchMembershipsResponse>> {
  const { userId } = request.params;
  if (!userId) {
    return { statusCode: 400, body: { error: 'INVALID_USER_ID' } };
  }

  const body = request.body ?? {};
  const membershipsInput = Array.isArray(body.memberships) ? body.memberships : [];
  if (membershipsInput.length === 0) {
    return { statusCode: 400, body: { error: 'NO_MEMBERSHIPS' } };
  }

  try {
    const repository = (request.server as any).repository as any;

    // Each entry is gated on its own brand, so a request mixing brands is only
    // as authorized as its weakest entry. A platform admin is the single
    // cross-brand identity and skips the per-entry check.
    const platformAdmin = isPlatformAdmin(request);
    if (!platformAdmin) {
      for (const m of membershipsInput) {
        const targetBrandId = m.brandId
          ?? (m.businessId ? await resolveBrandForBusiness(request, m.businessId) : null);
        const gate = requireServiceForTenant(request, targetBrandId);
        if (!gate.ok) return gate.response as ServiceResponse<{ error: string }>;
      }
    }

    const user = await repository.findUserById(userId);
    if (!user) {
      return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };
    }

    for (const m of membershipsInput) {
      await repository.upsertMembership(userId, { businessId: m.businessId ?? null, brandId: m.brandId, role: 'USER' });
    }

    // Phase 2.6: Keycloak attribute write removed. Token consumers no longer
    // read memberships from Keycloak attributes — they read from the local
    // UserMembership rows (or fall through to /me).

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error({ err: error }, 'PATCH_MEMBERSHIPS_FAILED');
    return { statusCode: 500, body: { error: 'PATCH_MEMBERSHIPS_FAILED' } };
  }
}
