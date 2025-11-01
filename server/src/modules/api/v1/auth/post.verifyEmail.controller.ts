import type { FastifyReply, FastifyRequest } from 'fastify';

import { postVerifyEmailService } from './post.verifyEmail.service.js';

export async function postVerifyEmailHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postVerifyEmailService(request);
  return reply.status(result.statusCode).send(result.body);
}
