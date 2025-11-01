import type { FastifyReply, FastifyRequest } from 'fastify';

import { patchMembershipsService } from './patch.memberships.service.js';

export async function patchMembershipsHandler(
  request: FastifyRequest<{ Params: { userId: string }; Body: { memberships?: Array<{ brandId: string | null; businessId: string; roles: string[] }> } }>,
  reply: FastifyReply
) {
  const result = await patchMembershipsService(request);
  return reply.status(result.statusCode).send(result.body);
}
