import type { FastifyReply, FastifyRequest } from 'fastify';

export async function serviceUpdateMembershipCountersHandler(request: FastifyRequest, reply: FastifyReply) {
  // Service auth: require allowed service audiences
  const auth = (request as any).auth as any;
  const azp = auth?.azp;
  const aud = auth?.aud;
  const allowedServices = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service,business-service')
    .split(',').map(s => s.trim());
  const audList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
  const isService = (azp && allowedServices.includes(azp)) || audList.some(a => allowedServices.includes(a));
  if (!isService) return reply.status(403).send({ error: 'FORBIDDEN' });

  const { userId } = (request.params as any) as { userId: string };
  const body = request.body as any;
  const businessId = String(body.businessId);
  if (!userId || !businessId) return reply.status(400).send({ error: 'INVALID_INPUT' });

  const counters = {
    validStamps: body.validStamps as number | undefined,
    validCoupons: body.validCoupons as number | undefined,
    totalStampsDelta: body.totalStampsDelta as number | undefined,
    totalCouponsDelta: body.totalCouponsDelta as number | undefined,
  };

  const repository = (request.server as any).repository as any;
  const updated = await repository.setMembershipCounters(userId, businessId, counters);
  return reply.send({ membership: updated });
}
