import type { FastifyReply, FastifyRequest } from 'fastify';

import { postPmHandoffService } from './post.pmHandoff.service.js';

export async function postPmHandoffHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postPmHandoffService(request);
  return reply.status(result.statusCode).send(result.body);
}
