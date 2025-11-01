import type { FastifyReply, FastifyRequest } from 'fastify';

import { getMeService } from './get.me.service.js';

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await getMeService(request);
  return reply.status(result.statusCode).send(result.body);
}
