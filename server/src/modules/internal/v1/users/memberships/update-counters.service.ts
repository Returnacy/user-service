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
  if (!userId || !businessId) {
    return { statusCode: 400, body: { error: 'INVALID_INPUT' } };
  }

  const counters = {
    validStamps: body?.validStamps as number | undefined,
    validCoupons: body?.validCoupons as number | undefined,
    totalStampsDelta: body?.totalStampsDelta as number | undefined,
    totalCouponsDelta: body?.totalCouponsDelta as number | undefined,
  };

  const repository = (request.server as any).repository as any;
  const updated = await repository.setMembershipCounters(userId, businessId, counters);
  return { statusCode: 200, body: { membership: updated } };
}
