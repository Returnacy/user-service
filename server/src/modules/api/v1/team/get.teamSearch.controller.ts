import type { FastifyReply, FastifyRequest } from 'fastify';

import { getTeamSearchService } from './get.teamSearch.service.js';

export async function getTeamSearchHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await getTeamSearchService(request);
  return reply.status(result.statusCode).send(result.body);
}
