import type { FastifyReply, FastifyRequest } from 'fastify';

import { postHandoffService } from './post.handoff.service.js';

export async function postHandoffHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postHandoffService(request);
  reply.header('Cache-Control', 'no-store');
  return reply.status(result.statusCode).send(result.body);
}
