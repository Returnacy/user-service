import type { FastifyReply, FastifyRequest } from 'fastify';

import { getTeamService } from './get.team.service.js';

export async function getTeamHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await getTeamService(request);
  return reply.status(result.statusCode).send(result.body);
}
