import type { FastifyInstance } from 'fastify';
import { requireAdminRole } from '../../utils/serviceAuthGuard.js';
import { patchMembershipsHandler } from './patch.memberships.controller.js';
import { getMeHandler } from './me.controller.js';
import { postAcceptancesHandler } from './post.acceptances.controller.js';
import { postProfileHandler } from './post.profile.controller.js';
import { getUserByIdHandler } from './get.user.controller.js';
import { serviceUpdateMembershipCountersHandler } from './post.membership-counters.internal.controller.js';
import { serviceGetWalletPassHandler } from './get.walletPass.internal.controller.js';
import { serviceUpsertWalletPassHandler } from './post.walletPass.internal.controller.js';

export async function usersRoutes(server: FastifyInstance) {
  server.get('/me', { preHandler: [], handler: getMeHandler });
  server.post('/me/acceptances', { preHandler: [], handler: postAcceptancesHandler });
  server.post('/me/profile', { preHandler: [], handler: postProfileHandler });
  server.patch('/users/:userId/memberships', { preHandler: [requireAdminRole()], handler: patchMembershipsHandler });
  server.get('/users/:userId', { preHandler: [], handler: getUserByIdHandler });
}

export async function usersInternalRoutes(server: FastifyInstance) {
  server.post('/internal/v1/users/:userId/memberships/counters', { preHandler: [], handler: serviceUpdateMembershipCountersHandler as any });
  server.get('/internal/v1/users/:userId/memberships/:businessId/wallet-pass', { preHandler: [], handler: serviceGetWalletPassHandler as any });
  server.post('/internal/v1/users/:userId/memberships/:businessId/wallet-pass', { preHandler: [], handler: serviceUpsertWalletPassHandler as any });
}
