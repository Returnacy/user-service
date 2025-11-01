import type { FastifyReply, FastifyRequest } from 'fastify';

import { postForgotPasswordService } from './post.forgotPassword.service.js';

export async function postForgotPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postForgotPasswordService(request);
  return reply.status(result.statusCode).send(result.body);
}
