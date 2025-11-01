import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type MembershipInput = { brandId: string | null; businessId: string; roles: string[] };

type PatchMembershipsResponse = { ok: true } | { error: string };

type TokenService = { getAccessToken(): Promise<string> };

export async function patchMembershipsService(
  request: FastifyRequest<{ Params: { userId: string }; Body: { memberships?: MembershipInput[] } }>
): Promise<ServiceResponse<PatchMembershipsResponse>> {
  const { userId } = request.params;
  if (!userId) {
    return { statusCode: 400, body: { error: 'INVALID_USER_ID' } };
  }

  const body = request.body ?? {};
  const membershipsInput = Array.isArray(body.memberships) ? body.memberships : [];

  try {
    const repository = (request.server as any).repository as any;
    const tokenService = (request.server as any).keycloakTokenService as TokenService;

    for (const m of membershipsInput) {
      await repository.upsertMembership(userId, { businessId: m.businessId, brandId: m.brandId, role: 'USER' });
    }

    const attribute = [JSON.stringify(membershipsInput)];
    const adminToken = await tokenService.getAccessToken();
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;

    const user = await repository.findUserById(userId);
    if (!user) {
      return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };
    }

    await axios.put(
      `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}`,
      { attributes: { memberships: attribute } },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error({ err: error }, 'PATCH_MEMBERSHIPS_FAILED');
    return { statusCode: 500, body: { error: 'PATCH_MEMBERSHIPS_FAILED' } };
  }
}
