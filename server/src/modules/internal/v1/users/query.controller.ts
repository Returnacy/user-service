import type { FastifyReply, FastifyRequest } from 'fastify';

import { postUsersQueryService } from './query.service.js';

export async function postInternalUsersQueryHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postUsersQueryService(request);
  return reply.status(result.statusCode).send(result.body);
}
