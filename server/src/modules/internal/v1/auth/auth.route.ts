import type { FastifyInstance } from 'fastify';

import {
  signServiceToken,
  resolveInternalServiceClient,
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
    const legacyClientIds = Object.entries(clients).filter(([, c]) => c.brandId === null).map(([id]) => id);
    server.log.info(
      { clientCount: Object.keys(clients).length, clientIds: Object.keys(clients), legacyClientIds },
      '[internal-auth] INTERNAL_SERVICE_CLIENTS loaded',
    );
    if (legacyClientIds.length > 0) {
      // Loud on purpose: these are the tenant-blind credentials that the
      // rotation is meant to retire. Silence here is what let them survive.
      server.log.warn(
        { legacyClientIds },
        '[internal-auth] tenant-blind service clients still configured (no brandId) — retire them, see PROVISION-BRAND.md',
      );
    }
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
      const client = resolveInternalServiceClient(clientId, clientSecret);
      if (!client) {
        return reply.status(401).send({ error: 'invalid_client' });
      }

      const roles = scope.split(/\s+/).filter(Boolean);

      const claims: ServiceTokenClaims = { azp: clientId };
      if (audience) claims.audience = audience;
      if (roles.length > 0) claims.roles = roles;
      if (scope) claims.scope = scope;
      // The tenant comes from the credential, never from the request body: a
      // caller must not be able to pick which brand it speaks for.
      if (client.brandId) claims.brandId = client.brandId;

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
