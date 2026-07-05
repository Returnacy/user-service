import type { FastifyReply, FastifyRequest } from 'fastify';

import { patchTeamService } from './patch.team.service.js';

export async function patchTeamHandler(request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) {
  const result = await patchTeamService(request);
  return reply.status(result.statusCode).send(result.body);
}
