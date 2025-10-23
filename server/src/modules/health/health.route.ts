import type { FastifyInstance } from 'fastify';
import { getHealthHandler, getReadinessHandler, getMetricsHandler } from './health.controller.js';

export async function healthRoute(server: FastifyInstance) {
  server.get('/health', { logLevel: 'warn', handler: getHealthHandler });
  server.get('/ready', { logLevel: 'warn', handler: getReadinessHandler });
  server.get('/metrics', { logLevel: 'silent', handler: getMetricsHandler });
}
