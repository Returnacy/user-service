import type { FastifyReply, FastifyRequest } from 'fastify';

import { postRefreshService } from './post.refresh.service.js';

export async function postRefreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postRefreshService(request);
  return reply.status(result.statusCode).send(result.body);
}
