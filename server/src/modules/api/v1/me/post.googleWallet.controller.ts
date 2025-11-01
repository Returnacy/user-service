import type { FastifyReply, FastifyRequest } from 'fastify';

import { postGoogleWalletService } from './post.googleWallet.service.js';

export async function postGoogleWalletHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postGoogleWalletService(request);
  return reply.status(result.statusCode).send(result.body);
}
