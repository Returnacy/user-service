import type { FastifyReply, FastifyRequest } from 'fastify';

import { upsertWalletPassService } from './upsert-wallet-pass.service.js';

export async function serviceUpsertWalletPassHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await upsertWalletPassService(request);
  return reply.status(result.statusCode).send(result.body);
}
