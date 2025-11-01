import type { FastifyReply, FastifyRequest } from 'fastify';

import { getWalletPassService } from './get-wallet-pass.service.js';

export async function serviceGetWalletPassHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await getWalletPassService(request);
  return reply.status(result.statusCode).send(result.body);
}
