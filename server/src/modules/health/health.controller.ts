import type { FastifyReply, FastifyRequest } from 'fastify';

import { getHealthService, getMetricsService, getReadinessService } from './health.service.js';

export async function getHealthHandler(_req: FastifyRequest, reply: FastifyReply) {
  const result = await getHealthService();
  return reply.status(result.statusCode).send(result.body);
}

export async function getReadinessHandler(_req: FastifyRequest, reply: FastifyReply) {
  const result = await getReadinessService();
  return reply.status(result.statusCode).send(result.body);
}

export async function getMetricsHandler(_req: FastifyRequest, reply: FastifyReply) {
  const result = await getMetricsService();
  reply.type('text/plain');
  return reply.status(result.statusCode).send(result.body);
}
