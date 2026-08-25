import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireServiceForTenant, resolveBrandForBusiness } from '@/utils/tenantGuard.js';

export async function serviceCountNewUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const q: any = request.query || {};
    const businessIdRaw = q.businessId ?? (request.body as any)?.businessId;
    const brandIdRaw = q.brandId ?? (request.body as any)?.brandId;
    const sinceRaw: string | undefined = q.since || (request.body as any)?.since;
    const businessId: string | undefined = typeof businessIdRaw === 'string' && businessIdRaw.length ? businessIdRaw : undefined;
    const brandId: string | undefined = typeof brandIdRaw === 'string' && brandIdRaw.length ? brandIdRaw : undefined;
    if (!businessId && !brandId) {
      return reply.status(400).send({ error: 'businessId or brandId required' });
    }

    const targetBrandId = brandId ?? (businessId ? await resolveBrandForBusiness(request, businessId) : null);
    const gate = requireServiceForTenant(request, targetBrandId);
    if (!gate.ok) return reply.status(gate.response.statusCode).send(gate.response.body);

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
