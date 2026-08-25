import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { requireServiceForTenant, resolveBrandForBusiness } from '@/utils/tenantGuard.js';

export async function getWalletPassService(request: FastifyRequest): Promise<ServiceResponse<{ linked: boolean; objectId: string | null; walletPass: any } | { error: string; message?: string }>> {
  const { userId, businessId } = request.params as { userId?: string; businessId?: string };
  if (!userId || !businessId) {
    return { statusCode: 400, body: { error: 'INVALID_INPUT', message: 'userId and businessId are required' } };
  }

  const gate = requireServiceForTenant(request, await resolveBrandForBusiness(request, businessId));
  if (!gate.ok) return gate.response as ServiceResponse<{ error: string }>;

  const repository = (request.server as any).repository as any;
  if (!repository?.findWalletPass) {
    return { statusCode: 500, body: { error: 'SERVER_MISCONFIGURED' } };
  }

  const walletPass = await repository.findWalletPass(userId, businessId);
  if (!walletPass) {
    return { statusCode: 200, body: { linked: false, objectId: null, walletPass: null } };
  }

  return {
    statusCode: 200,
    body: {
      linked: true,
      objectId: walletPass.objectId ?? null,
      walletPass: {
        id: walletPass.id,
        userMembershipId: walletPass.userMembershipId,
        objectId: walletPass.objectId ?? null,
        createdAt: walletPass.createdAt instanceof Date ? walletPass.createdAt.toISOString() : walletPass.createdAt,
        updatedAt: walletPass.updatedAt instanceof Date ? walletPass.updatedAt.toISOString() : walletPass.updatedAt,
      },
    },
  };
}
