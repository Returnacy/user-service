import type { FastifyInstance } from 'fastify';

import {
  signServiceToken,
  validateInternalServiceCredentials,
  getInternalServiceClients,
  type ServiceTokenClaims,
} from '@/utils/selfIssuedJwt.js';

type ServiceTokenBody = {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  audience?: string;
};

const ACCESS_TOKEN_TTL_SECONDS = 300;

export async function internalAuthRoute(server: FastifyInstance) {
  const clients = getInternalServiceClients();
  if (!clients) {
    server.log.warn('[internal-auth] INTERNAL_SERVICE_CLIENTS env var is unset, empty, or invalid JSON; service-token endpoint will reject all requests');
  } else {
    server.log.info({ clientCount: Object.keys(clients).length, clientIds: Object.keys(clients) }, '[internal-auth] INTERNAL_SERVICE_CLIENTS loaded');
  }

  server.post<{ Body: ServiceTokenBody }>('/service-token', {
    schema: {
      body: {
        type: 'object',
        required: ['grant_type', 'client_id', 'client_secret'],
        properties: {
          grant_type: { type: 'string' },
          client_id: { type: 'string', minLength: 1 },
          client_secret: { type: 'string', minLength: 1 },
          scope: { type: 'string' },
          audience: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = request.body ?? {};
      const grantType = body.grant_type;
      const clientId = body.client_id;
      const clientSecret = body.client_secret;
      const scope = body.scope ?? '';
      const audience = body.audience;

      if (grantType !== 'client_credentials') {
        return reply.status(400).send({ error: 'unsupported_grant_type' });
      }
      if (!clientId || !clientSecret) {
        return reply.status(400).send({ error: 'invalid_request' });
      }
      if (!validateInternalServiceCredentials(clientId, clientSecret)) {
        return reply.status(401).send({ error: 'invalid_client' });
      }

      const roles = scope.split(/\s+/).filter(Boolean);

      const claims: ServiceTokenClaims = { azp: clientId };
      if (audience) claims.audience = audience;
      if (roles.length > 0) claims.roles = roles;
      if (scope) claims.scope = scope;

      const accessToken = await signServiceToken(claims, { ttlSeconds: ACCESS_TOKEN_TTL_SECONDS });

      reply.header('Cache-Control', 'no-store');
      return {
        access_token: accessToken,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_expires_in: 0,
        token_type: 'Bearer',
        'not-before-policy': 0,
        scope,
      };
    },
  });
}
