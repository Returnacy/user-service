import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';

type VerifyEmailBody = {
  redirectUri?: string;
};

export async function postVerifyEmailHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

  try {
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;
    const clientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || 'frontend-spa';
    const body = (request.body || {}) as Partial<VerifyEmailBody>;

    const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };
    const adminToken = await tokenService.getAccessToken();

    const actions = ["VERIFY_EMAIL"];
    const params = new URLSearchParams({ client_id: clientId });
    if (body.redirectUri) params.set('redirect_uri', body.redirectUri);
    await axios.put(`${baseUrl}/admin/realms/${realm}/users/${auth.sub}/execute-actions-email?${params.toString()}`,
      actions, { headers: { Authorization: `Bearer ${adminToken}` } });
    return reply.send({ ok: true });
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return reply.status(400).send({ error: 'VERIFY_EMAIL_FAILED' });
  }
}
