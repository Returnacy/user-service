import type { FastifyInstance } from 'fastify';

import { getMeHandler } from './get.me.controller.js';
import { postAcceptancesHandler } from './post.acceptances.controller.js';
import { postGoogleWalletHandler } from './post.googleWallet.controller.js';
import { postProfileHandler } from './post.profile.controller.js';

export async function meRoute(server: FastifyInstance) {
  server.get('/', { handler: getMeHandler });
  server.post('/acceptances', { handler: postAcceptancesHandler });
  server.post('/profile', { handler: postProfileHandler });
  server.post('/google-wallet', { handler: postGoogleWalletHandler });
}
