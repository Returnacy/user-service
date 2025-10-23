import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';

type ForgotPasswordBody = {
  email: string;
  redirectUri?: string;
};

export async function postForgotPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const body = (request.body || {}) as Partial<ForgotPasswordBody>;
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return reply.status(400).send({ error: 'EMAIL_REQUIRED' });

    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;
    const clientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || 'frontend-spa';

    const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };
    const adminToken = await tokenService.getAccessToken();

    // Find user by email (exact)
    const search = await axios.get(
      `${baseUrl}/admin/realms/${realm}/users`,
      { params: { email, exact: true }, headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const user = Array.isArray(search.data) ? search.data[0] : null;
    if (!user?.id) return reply.status(404).send({ error: 'USER_NOT_FOUND' });

    const params = new URLSearchParams({ client_id: clientId });
    if (body.redirectUri) params.set('redirect_uri', body.redirectUri);

    const actions = ["UPDATE_PASSWORD"];
    await axios.put(
      `${baseUrl}/admin/realms/${realm}/users/${user.id}/execute-actions-email?${params.toString()}`,
      actions,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    return reply.send({ ok: true });
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return reply.status(400).send({ error: 'FORGOT_PASSWORD_FAILED' });
  }
}
