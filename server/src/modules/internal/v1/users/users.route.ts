import type { FastifyInstance } from 'fastify';

import { postInternalUsersQueryHandler } from './query.controller.js';
import { serviceGetWalletPassHandler } from './memberships/get-wallet-pass.controller.js';
import { serviceUpdateMembershipCountersHandler } from './memberships/update-counters.controller.js';
import { serviceUpsertWalletPassHandler } from './memberships/upsert-wallet-pass.controller.js';

export async function internalUsersRoute(server: FastifyInstance) {
  server.post('/query', { handler: postInternalUsersQueryHandler });
  server.post('/:userId/memberships/counters', { handler: serviceUpdateMembershipCountersHandler });
  server.get('/:userId/memberships/:businessId/wallet-pass', { handler: serviceGetWalletPassHandler });
  server.post('/:userId/memberships/:businessId/wallet-pass', { handler: serviceUpsertWalletPassHandler });
}
