import type { FastifyReply, FastifyRequest } from 'fastify';

import { postAcceptancesService } from './post.acceptances.service.js';

export async function postAcceptancesHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postAcceptancesService(request);
  return reply.status(result.statusCode).send(result.body);
}
