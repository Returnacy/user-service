import type { FastifyReply, FastifyRequest } from 'fastify';

import { postLoginService } from './post.login.service.js';

export async function postLoginHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postLoginService(request);
  return reply.status(result.statusCode).send(result.body);
}
