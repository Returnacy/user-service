import type { FastifyInstance } from 'fastify';

import { requireAdminRole } from '@/utils/serviceAuthGuard.js';

import { getUserByIdHandler } from './get.user.controller.js';
import { patchMembershipsHandler } from './patch.memberships.controller.js';

export async function usersRoute(server: FastifyInstance) {
  server.get('/:userId', { handler: getUserByIdHandler });
  server.patch('/:userId/memberships', { preHandler: [requireAdminRole()], handler: patchMembershipsHandler });
}
