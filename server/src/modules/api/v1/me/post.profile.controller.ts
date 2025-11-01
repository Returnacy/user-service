import type { FastifyReply, FastifyRequest } from 'fastify';

import { postProfileService } from './post.profile.service.js';

export async function postProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postProfileService(request);
  return reply.status(result.statusCode).send(result.body);
}
