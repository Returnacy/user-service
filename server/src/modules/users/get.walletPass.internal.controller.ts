import type { FastifyReply, FastifyRequest } from 'fastify';

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

export async function serviceGetWalletPassHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!isServiceRequest(request)) {
    return reply.status(403).send({ error: 'FORBIDDEN' });
  }

  const { userId, businessId } = request.params as { userId?: string; businessId?: string };
  if (!userId || !businessId) {
    return reply.status(400).send({ error: 'INVALID_INPUT', message: 'userId and businessId are required' });
  }

  const repository = (request.server as any).repository as any;
  if (!repository?.findWalletPass) {
    return reply.status(500).send({ error: 'SERVER_MISCONFIGURED' });
  }

  const walletPass = await repository.findWalletPass(userId, businessId);
  if (!walletPass) {
    return reply.send({ linked: false, objectId: null, walletPass: null });
  }

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
}
