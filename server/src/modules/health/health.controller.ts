import type { FastifyReply, FastifyRequest } from 'fastify';

export async function getHealthHandler(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({ status: 'ok' });
}

export async function getReadinessHandler(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({ ready: true });
}

export async function getMetricsHandler(_req: FastifyRequest, reply: FastifyReply) {
  reply.type('text/plain');
  return reply.send('# no metrics yet');
}
