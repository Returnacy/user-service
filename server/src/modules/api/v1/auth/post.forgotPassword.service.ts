import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type ForgotPasswordBody = {
  email: string;
  redirectUri?: string;
};

type TokenService = { getAccessToken(): Promise<string> };

type ForgotPasswordResponse = { ok: true } | { error: string };

export async function postForgotPasswordService(request: FastifyRequest): Promise<ServiceResponse<ForgotPasswordResponse>> {
  try {
    const body = (request.body || {}) as Partial<ForgotPasswordBody>;
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) {
      return { statusCode: 400, body: { error: 'EMAIL_REQUIRED' } };
    }

    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;
    const clientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || 'frontend-spa';

    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const adminToken = await tokenService.getAccessToken();

    const search = await axios.get(
      `${baseUrl}/admin/realms/${realm}/users`,
      { params: { email, exact: true }, headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const user = Array.isArray(search.data) ? search.data[0] : null;
    if (!user?.id) {
      return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };
    }

    const params = new URLSearchParams({ client_id: clientId });
    if (body.redirectUri) params.set('redirect_uri', body.redirectUri);

    const actions = ['UPDATE_PASSWORD'];
    await axios.put(
      `${baseUrl}/admin/realms/${realm}/users/${user.id}/execute-actions-email?${params.toString()}`,
      actions,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'FORGOT_PASSWORD_FAILED' } };
  }
}
