import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { requireServiceForTenant, resolveBrandForBusiness } from '@/utils/tenantGuard.js';

const bodySchema = z.object({
  objectId: z.string().min(1).optional(),
});

export async function upsertWalletPassService(request: FastifyRequest): Promise<ServiceResponse<{ linked: boolean; objectId: string | null; walletPass: any } | { error: string; message?: string }>> {
  const { userId, businessId } = request.params as { userId?: string; businessId?: string };
  if (!userId || !businessId) {
    return { statusCode: 400, body: { error: 'INVALID_INPUT', message: 'userId and businessId are required' } };
  }

  const gate = requireServiceForTenant(request, await resolveBrandForBusiness(request, businessId));
  if (!gate.ok) return gate.response as ServiceResponse<{ error: string }>;

  const parseResult = bodySchema.safeParse(request.body ?? {});
  if (!parseResult.success) {
    return { statusCode: 400, body: { error: 'INVALID_PAYLOAD', details: parseResult.error.flatten() } as any };
  }

  const repository = (request.server as any).repository as any;
  if (!repository?.upsertWalletPass) {
    return { statusCode: 500, body: { error: 'SERVER_MISCONFIGURED' } };
  }

  try {
    const walletPass = await repository.upsertWalletPass(userId, businessId, { objectId: parseResult.data.objectId ?? null });
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
  } catch (error: any) {
    if (error?.code === 'MEMBERSHIP_NOT_FOUND') {
      return { statusCode: 404, body: { error: 'MEMBERSHIP_NOT_FOUND' } };
    }
    request.server.log.error({ err: error }, 'Failed to persist wallet pass');
    return {
      statusCode: 500,
      body: { error: 'WALLET_PASS_PERSISTENCE_FAILED', message: error?.message ?? 'Unexpected error' },
    };
  }
}
