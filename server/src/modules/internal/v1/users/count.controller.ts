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
    const businessId: string | undefined = q.businessId || (request.body as any)?.businessId;
    if (!businessId || typeof businessId !== 'string') {
      return reply.status(400).send({ error: 'businessId required' });
    }

    const repository: any = (request.server as any).repository;
    const count: number = await (repository?.countUsersByBusiness?.(businessId) ?? 0);
    return reply.status(200).send({ count });
  } catch (e) {
    request.log.error(e);
    return reply.status(500).send({ error: 'INTERNAL_ERROR' });
  }
}
