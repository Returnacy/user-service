import type { FastifyReply, FastifyRequest } from 'fastify';

import { postUsersQueryService } from './query.service.js';

export async function postInternalUsersQueryHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const result = await postUsersQueryService(request);
    return reply.status(result.statusCode).send(result.body);
  } catch (error) {
    request.log.error({ err: error }, 'Unhandled error in postInternalUsersQueryHandler');
    return reply.status(500).send({ error: 'INTERNAL_ERROR' });
  }
}
