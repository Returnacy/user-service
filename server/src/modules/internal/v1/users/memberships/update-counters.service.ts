import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';

function isServiceRequest(request: FastifyRequest): boolean {
  const auth = (request as any).auth as any;
  const azp = auth?.azp;
  const aud = auth?.aud;
  const allowedServices = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service,business-service')
    .split(',').map((s) => s.trim());
  const audList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
  return (azp && allowedServices.includes(azp)) || audList.some((entry) => allowedServices.includes(entry));
}

export async function updateMembershipCountersService(request: FastifyRequest): Promise<ServiceResponse<{ membership: any } | { error: string }>> {
  if (!isServiceRequest(request)) {
    return { statusCode: 403, body: { error: 'FORBIDDEN' } };
  }

  const { userId } = (request.params as any) as { userId: string };
  const body = request.body as any;
  const businessId = String(body?.businessId ?? '');
  const brandId = body?.brandId ? String(body.brandId) : '';
  const scope = String(body?.scope ?? 'LOCATION');
  // Need at least one way to locate the membership.
  if (!userId || (!businessId && !brandId)) {
    return { statusCode: 400, body: { error: 'INVALID_INPUT' } };
  }

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
  const membership = (scope === 'BRAND' && brandId)
    ? await repository.getMembershipByBrand(userId, brandId)
    : await repository.getMembership(userId, businessId);
  if (!membership) {
    return { statusCode: 404, body: { error: 'MEMBERSHIP_NOT_FOUND' } };
  }
  const updated = await repository.applyMembershipCounters(membership, counters);
  return { statusCode: 200, body: { membership: updated } };
}
