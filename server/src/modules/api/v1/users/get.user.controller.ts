import type { FastifyReply, FastifyRequest } from 'fastify';

import { getUserService } from './get.user.service.js';

export async function getUserByIdHandler(request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) {
  const result = await getUserService(request);
  return reply.status(result.statusCode).send(result.body);
}
