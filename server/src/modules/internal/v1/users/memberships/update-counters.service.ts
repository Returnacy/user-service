import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { findMembershipInBrand, requireServiceForTenant, resolveBrandForBusiness } from '@/utils/tenantGuard.js';

export async function updateMembershipCountersService(request: FastifyRequest): Promise<ServiceResponse<{ membership: any } | { error: string }>> {
  const { userId } = (request.params as any) as { userId: string };
  const body = request.body as any;
  const businessId = String(body?.businessId ?? '');
  const brandId = body?.brandId ? String(body.brandId) : '';
  const scope = String(body?.scope ?? 'LOCATION');
  // Need at least one way to locate the membership.
  if (!userId || (!businessId && !brandId)) {
    return { statusCode: 400, body: { error: 'INVALID_INPUT' } };
  }

  // Writing stamp/coupon counters is a write into a tenant's loyalty ledger, so
  // the caller's credential must belong to the brand that owns the membership.
  const targetBrandId = brandId || (businessId ? await resolveBrandForBusiness(request, businessId) : null);
  const gate = requireServiceForTenant(request, targetBrandId);
  if (!gate.ok) return gate.response as ServiceResponse<{ error: string }>;

  const counters = {
    validStamps: body?.validStamps as number | undefined,
    validCoupons: body?.validCoupons as number | undefined,
    totalStampsDelta: body?.totalStampsDelta as number | undefined,
    totalCouponsDelta: body?.totalCouponsDelta as number | undefined,
  };

  const repository = (request.server as any).repository as any;
  // Under a BRAND wallet the counters live on the single brand-scoped membership
  // (the per-location membershipId may not exist for the location being stamped),
  // so resolve by brand. Otherwise resolve by the specific location.
  //
  // findMembershipInBrand rather than getMembershipByBrand: a customer whose
  // only row is a legacy one (businessId set, brandId NULL) has no brand-scoped
  // row, so the narrow lookup returned null and this answered 404
  // MEMBERSHIP_NOT_FOUND. The stamp still lands in business-service's DB, but
  // the counters never sync — precisely the failure MULTI_LOCATION_ROLLOUT.md's
  // verification step 5 says to watch for. The exact brand row still wins when
  // it exists, so nothing changes for a normal customer.
  const membership = (scope === 'BRAND' && brandId)
    ? await findMembershipInBrand(request, userId, brandId)
    : await repository.getMembership(userId, businessId);
  if (!membership) {
    return { statusCode: 404, body: { error: 'MEMBERSHIP_NOT_FOUND' } };
  }
  const updated = await repository.applyMembershipCounters(membership, counters);
  return { statusCode: 200, body: { membership: updated } };
}
