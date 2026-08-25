import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireServiceForTenant, resolveBrandForBusiness } from '@/utils/tenantGuard.js';

export async function serviceCountUsersHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const q: any = request.query || {};
    const businessIdRaw = q.businessId ?? (request.body as any)?.businessId;
    const brandIdRaw = q.brandId ?? (request.body as any)?.brandId;
    const businessId: string | undefined = typeof businessIdRaw === 'string' && businessIdRaw.length ? businessIdRaw : undefined;
    const brandId: string | undefined = typeof brandIdRaw === 'string' && brandIdRaw.length ? brandIdRaw : undefined;
    if (!businessId && !brandId) {
      return reply.status(400).send({ error: 'businessId or brandId required' });
    }

    const targetBrandId = brandId ?? (businessId ? await resolveBrandForBusiness(request, businessId) : null);
    const gate = requireServiceForTenant(request, targetBrandId);
    if (!gate.ok) return reply.status(gate.response.statusCode).send(gate.response.body);

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
