import type { FastifyReply, FastifyRequest } from 'fastify';

export async function serviceCountNewUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    // Service auth similar to other internal endpoints
    const auth: any = (request as any).auth;
    const azp = auth?.azp;
    const aud = auth?.aud;
    const allowedServices = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service')
      .split(',').map((s) => s.trim());
    const audList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
    const isService = (azp && allowedServices.includes(azp)) || audList.some((a) => allowedServices.includes(a));
    if (!isService) {
      return reply.status(403).send({ error: 'FORBIDDEN' });
    }

    const q: any = request.query || {};
    const businessIdRaw = q.businessId ?? (request.body as any)?.businessId;
    const brandIdRaw = q.brandId ?? (request.body as any)?.brandId;
    const sinceRaw: string | undefined = q.since || (request.body as any)?.since;
    const businessId: string | undefined = typeof businessIdRaw === 'string' && businessIdRaw.length ? businessIdRaw : undefined;
    const brandId: string | undefined = typeof brandIdRaw === 'string' && brandIdRaw.length ? brandIdRaw : undefined;
    if (!businessId && !brandId) {
      return reply.status(400).send({ error: 'businessId or brandId required' });
    }
    if (!sinceRaw || typeof sinceRaw !== 'string') {
      return reply.status(400).send({ error: 'since required (ISO date string)' });
    }
    const since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) {
      return reply.status(400).send({ error: 'since invalid date' });
    }

    const repository: any = (request.server as any).repository;
    const count: number = businessId
      ? await (repository?.countNewUsersSince?.(businessId, since) ?? 0)
      : await (repository?.countNewUsersSinceBrand?.(brandId, since) ?? 0);
    return reply.status(200).send({ count });
  } catch (e) {
    request.log.error(e);
    return reply.status(500).send({ error: 'INTERNAL_ERROR' });
  }
}
