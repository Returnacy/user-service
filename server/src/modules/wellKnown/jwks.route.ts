import type { FastifyInstance } from 'fastify';

import { getJwks } from '@/utils/selfIssuedJwt.js';

export async function jwksRoute(server: FastifyInstance) {
  server.get('/.well-known/jwks.json', { logLevel: 'warn' }, async (_request, reply) => {
    const jwks = await getJwks();
    reply.header('Cache-Control', 'public, max-age=300');
    return jwks;
  });
}
