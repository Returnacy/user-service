import type { FastifyReply, FastifyRequest } from 'fastify';

import { postRegisterService } from './post.register.service.js';

export async function postRegisterHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postRegisterService(request);
  return reply.status(result.statusCode).send(result.body);
}
