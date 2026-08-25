import type { FastifyInstance } from 'fastify';

import { requireBrandRole } from '@/utils/tenantGuard.js';

import { getUserByIdHandler } from './get.user.controller.js';
import { patchMembershipsHandler } from './patch.memberships.controller.js';

export async function usersRoute(server: FastifyInstance) {
  // GET /:userId used to have NO guard at all: any authenticated user — a
  // customer of any brand — could read any other user's email, phone and
  // cross-brand memberships by iterating ids. It is now staff-of-this-brand
  // only, and the payload is filtered to that brand (see get.user.service.ts).
  server.get('/:userId', { preHandler: [requireBrandRole()], handler: getUserByIdHandler });

  // Membership writes are service-or-platform-admin only, and the credential
  // must be bound to the brand being written (see patch.memberships.service).
  // The guard that used to sit here, requireAdminRole(), was tenant-blind and
  // in practice dead for users: user tokens carry no membership claims, so its
  // `isAdmin` branch was always false and only `isService` ever passed — a
  // shared secret was enough to enrol anyone into anyone's brand.
  server.patch('/:userId/memberships', { handler: patchMembershipsHandler });
}
