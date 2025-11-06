import type { FastifyReply, FastifyRequest } from 'fastify';

export async function serviceCountUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    // Basic service auth guard similar to query.service
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
    const businessId: string | undefined = typeof businessIdRaw === 'string' && businessIdRaw.length ? businessIdRaw : undefined;
    const brandId: string | undefined = typeof brandIdRaw === 'string' && brandIdRaw.length ? brandIdRaw : undefined;
    if (!businessId && !brandId) {
      return reply.status(400).send({ error: 'businessId or brandId required' });
    }

    const repository: any = (request.server as any).repository;
    const count: number = businessId
      ? await (repository?.countUsersByBusiness?.(businessId) ?? 0)
      : await (repository?.countUsersByBrand?.(brandId) ?? 0);
    return reply.status(200).send({ count });
  } catch (e) {
    request.log.error(e);
    return reply.status(500).send({ error: 'INTERNAL_ERROR' });
  }
}
