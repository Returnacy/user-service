import type { FastifyReply, FastifyRequest } from 'fastify';

import { updateMembershipCountersService } from './update-counters.service.js';

export async function serviceUpdateMembershipCountersHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await updateMembershipCountersService(request);
  return reply.status(result.statusCode).send(result.body);
}
