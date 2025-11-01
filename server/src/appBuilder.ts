import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';

import keycloakTokenPlugin from './plugins/keycloakTokenPlugin.js';
import keycloakAuthPlugin from './plugins/keycloakAuthPlugin.js';
import userAuthPlugin from './plugins/userAuthPlugin.js';

import { healthRoute } from './modules/health/health.route.js';
import { authRoute } from './modules/api/v1/auth/auth.route.js';
import { meRoute } from './modules/api/v1/me/me.route.js';
import { usersRoute } from './modules/api/v1/users/users.route.js';
import { internalUsersRoute } from './modules/internal/v1/users/users.route.js';

type Overrides = {
  repository?: any;
  tokenService?: { getAccessToken(): Promise<string> };
};

export async function buildServer(opts?: { overrides?: Overrides }) {
  const server = Fastify({ logger: true });

  const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
  await server.register(fastifyCors, { origin: CORS_ORIGIN.split(',').map((s: string) => s.trim()) });

  if (!opts?.overrides?.repository) {
    const { default: prismaRepositoryPlugin } = await import('./plugins/prismaRepositoryPlugin.js');
    await server.register(prismaRepositoryPlugin);
  } else {
    (server as any).repository = opts.overrides.repository;
  }
  if (!opts?.overrides?.tokenService) {
    await server.register(keycloakTokenPlugin);
  } else {
    (server as any).keycloakTokenService = opts.overrides.tokenService;
  }
  await server.register(keycloakAuthPlugin);
  await server.register(userAuthPlugin);

  await server.register(healthRoute);
  await server.register(authRoute, { prefix: '/api/v1/auth' });
  await server.register(meRoute, { prefix: '/api/v1/me' });
  await server.register(usersRoute, { prefix: '/api/v1/users' });
  await server.register(internalUsersRoute, { prefix: '/internal/v1/users' });

  return server;
}
