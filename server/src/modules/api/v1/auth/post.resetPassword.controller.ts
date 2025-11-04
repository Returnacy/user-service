import type { FastifyReply, FastifyRequest } from 'fastify';
import { postResetPasswordService } from './post.resetPassword.service.js';

export async function postResetPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postResetPasswordService(request);
  return reply.status(result.statusCode).send(result.body);
}
