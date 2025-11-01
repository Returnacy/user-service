import type { FastifyReply, FastifyRequest } from 'fastify';

import { postLogoutService } from './post.logout.service.js';

export async function postLogoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postLogoutService(request);
  return reply.status(result.statusCode).send(result.body);
}
