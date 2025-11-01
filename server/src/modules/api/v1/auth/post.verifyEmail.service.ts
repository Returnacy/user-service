import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type VerifyEmailBody = {
  redirectUri?: string;
};

type TokenService = { getAccessToken(): Promise<string> };

type VerifyEmailResponse = { ok: true } | { error: string };

export async function postVerifyEmailService(request: FastifyRequest): Promise<ServiceResponse<VerifyEmailResponse>> {
  const auth = (request as any).auth as any;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;
    const clientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || 'frontend-spa';
    const body = (request.body || {}) as Partial<VerifyEmailBody>;

    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const adminToken = await tokenService.getAccessToken();

    const actions = ['VERIFY_EMAIL'];
    const params = new URLSearchParams({ client_id: clientId });
    if (body.redirectUri) params.set('redirect_uri', body.redirectUri);

    await axios.put(
      `${baseUrl}/admin/realms/${realm}/users/${auth.sub}/execute-actions-email?${params.toString()}`,
      actions,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'VERIFY_EMAIL_FAILED' } };
  }
}
