import type { FastifyReply, FastifyRequest } from 'fastify';
import { postVerifyEmailConfirmService } from './post.verifyEmailConfirm.service.js';

export async function postVerifyEmailConfirmHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postVerifyEmailConfirmService(request);
  return reply.status(result.statusCode).send(result.body);
}
