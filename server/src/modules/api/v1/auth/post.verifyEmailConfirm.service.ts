import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type VerifyConfirmBody = { token: string };

type TokenService = { getAccessToken(): Promise<string> };

type VerifyConfirmResponse = { ok: true } | { error: string };

export async function postVerifyEmailConfirmService(request: FastifyRequest): Promise<ServiceResponse<VerifyConfirmResponse>> {
  try {
    const body = (request.body || {}) as Partial<VerifyConfirmBody>;
    const token = String(body.token || '').trim();
    if (!token) return { statusCode: 400, body: { error: 'TOKEN_REQUIRED' } };

    const repository = (request.server as any).repository as any;
    const row = await repository.consumeEmailVerificationToken(token);
    if (!row) return { statusCode: 400, body: { error: 'INVALID_OR_EXPIRED_TOKEN' } };

    const user = await repository.findUserById(row.userId);
    if (!user) return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };

    // Mark email verified in Keycloak
    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const adminAccessToken = await tokenService.getAccessToken();
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;

    await axios.put(
      `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}`,
      { emailVerified: true },
      { headers: { Authorization: `Bearer ${adminAccessToken}` } }
    );

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'VERIFY_EMAIL_CONFIRM_FAILED' } };
  }
}
