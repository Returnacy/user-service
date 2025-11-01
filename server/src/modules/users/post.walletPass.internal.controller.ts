import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

function isServiceRequest(request: FastifyRequest): boolean {
  const auth = (request as any).auth as any;
  const azp = auth?.azp;
  const aud = auth?.aud;
  const allowed = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service,business-service')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const audienceList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
  return (azp && allowed.includes(azp)) || audienceList.some((entry) => allowed.includes(entry));
}

const bodySchema = z.object({
  objectId: z.string().min(1).optional(),
});

export async function serviceUpsertWalletPassHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isServiceRequest(request)) {
    return reply.status(403).send({ error: 'FORBIDDEN' });
  }

  const { userId, businessId } = request.params as { userId?: string; businessId?: string };
  if (!userId || !businessId) {
    return reply.status(400).send({ error: 'INVALID_INPUT', message: 'userId and businessId are required' });
  }

  const parseResult = bodySchema.safeParse(request.body ?? {});
  if (!parseResult.success) {
    return reply.status(400).send({ error: 'INVALID_PAYLOAD', details: parseResult.error.flatten() });
  }

  const repository = (request.server as any).repository as any;
  if (!repository?.upsertWalletPass) {
    return reply.status(500).send({ error: 'SERVER_MISCONFIGURED' });
  }

  try {
    const walletPass = await repository.upsertWalletPass(userId, businessId, { objectId: parseResult.data.objectId ?? null });
    return reply.send({
      linked: true,
      objectId: walletPass.objectId ?? null,
      walletPass: {
        id: walletPass.id,
        userMembershipId: walletPass.userMembershipId,
        objectId: walletPass.objectId ?? null,
        createdAt: walletPass.createdAt instanceof Date ? walletPass.createdAt.toISOString() : walletPass.createdAt,
        updatedAt: walletPass.updatedAt instanceof Date ? walletPass.updatedAt.toISOString() : walletPass.updatedAt,
      },
    });
  } catch (error: any) {
    if (error?.code === 'MEMBERSHIP_NOT_FOUND') {
      return reply.status(404).send({ error: 'MEMBERSHIP_NOT_FOUND' });
    }
    request.server.log.error({ err: error }, 'Failed to persist wallet pass');
    return reply.status(500).send({ error: 'WALLET_PASS_PERSISTENCE_FAILED', message: error?.message ?? 'Unexpected error' });
  }
}
