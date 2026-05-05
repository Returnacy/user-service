import type { FastifyInstance } from 'fastify';

import { isServiceCaller } from '@/utils/serviceCallerGuard.js';
import { getMeHandler } from './get.me.controller.js';
import { postAcceptancesHandler } from './post.acceptances.controller.js';
import { postGoogleWalletHandler } from './post.googleWallet.controller.js';
import { postProfileHandler } from './post.profile.controller.js';

export async function meRoute(server: FastifyInstance) {
  // /me/* is for end-user clients only. Reject service-to-service tokens to
  // prevent the upstream upsert from minting phantom User rows keyed by a
  // service client_id (or service-account UUID).
  server.addHook('preHandler', async (request, reply) => {
    if (isServiceCaller((request as any).auth)) {
      return reply.code(403).send({ error: 'SERVICE_TOKEN_NOT_ALLOWED' });
    }
  });

  server.get('/', { handler: getMeHandler });
  server.post('/acceptances', { handler: postAcceptancesHandler });
  server.post('/profile', { handler: postProfileHandler });
  server.post('/google-wallet', { handler: postGoogleWalletHandler });
}
