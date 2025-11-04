import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type ResetPasswordBody = {
  token: string;
  newPassword: string;
};

type TokenService = { getAccessToken(): Promise<string> };

type ResetPasswordResponse = { ok: true } | { error: string };

export async function postResetPasswordService(request: FastifyRequest): Promise<ServiceResponse<ResetPasswordResponse>> {
  try {
    const body = (request.body || {}) as Partial<ResetPasswordBody>;
    const token = String(body.token || '').trim();
    const newPassword = String(body.newPassword || '').trim();
    if (!token || !newPassword) {
      return { statusCode: 400, body: { error: 'TOKEN_AND_PASSWORD_REQUIRED' } };
    }

    const repository = (request.server as any).repository as any;
    const row = await repository.consumePasswordResetToken(token);
    if (!row) return { statusCode: 400, body: { error: 'INVALID_OR_EXPIRED_TOKEN' } };

    const user = await repository.findUserById(row.userId);
    if (!user) return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };

    // Update password via Keycloak Admin API
    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const adminAccessToken = await tokenService.getAccessToken();
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;

    await axios.put(
      `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}/reset-password`,
      { type: 'password', temporary: false, value: newPassword },
      { headers: { Authorization: `Bearer ${adminAccessToken}` } }
    );

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'RESET_PASSWORD_FAILED' } };
  }
}
