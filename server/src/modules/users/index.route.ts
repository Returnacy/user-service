import type { FastifyInstance } from 'fastify';

import { meRoute } from '../api/v1/me/me.route.js';
import { usersRoute } from '../api/v1/users/users.route.js';
import { internalUsersRoute } from '../internal/v1/users/users.route.js';

export async function usersRoutes(server: FastifyInstance) {
  await server.register(meRoute, { prefix: '/me' });
  await server.register(usersRoute, { prefix: '/users' });
}

export async function usersInternalRoutes(server: FastifyInstance) {
  await server.register(internalUsersRoute);
}
