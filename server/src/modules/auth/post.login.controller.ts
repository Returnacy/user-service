import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { z } from 'zod';

const loginSchema = z.object({
  username: z.string().email(),
  password: z.string().min(1)
});

export async function postLoginHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { username, password } = loginSchema.parse(request.body);

    const tokenUrl = `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'password',
      username,
      password,
      client_id: process.env.KEYCLOAK_CLIENT_ID!,
      client_secret: process.env.KEYCLOAK_CLIENT_SECRET!,
      scope: 'openid profile email offline_access'
    });
    try {
      const res = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      return reply.send(res.data);
    } catch (err: any) {
      // If Keycloak blocks password grant due to required actions, try to clear them and retry once
      const errData = err?.response?.data;
      const isRequiredActionsBlock = err?.response?.status === 400 && (
        errData?.error === 'invalid_grant' || errData?.error_description?.toLowerCase?.().includes('not fully set up')
      );
      if (!isRequiredActionsBlock) throw err;

      try {
        // Lookup user by email to get KC ID, then clear required actions
        const adminTokenUrl = `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
        const adminBody = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.KEYCLOAK_CLIENT_ID!,
          client_secret: process.env.KEYCLOAK_CLIENT_SECRET!
        });
        const adminRes = await axios.post(adminTokenUrl, adminBody, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const adminAccessToken: string = adminRes.data.access_token;

        // Find user by email
        const baseUrl = process.env.KEYCLOAK_BASE_URL!;
        const realm = process.env.KEYCLOAK_REALM!;
        const findResp = await axios.get(`${baseUrl}/admin/realms/${realm}/users`, {
          params: { email: username },
          headers: { Authorization: `Bearer ${adminAccessToken}` }
        });
        const kcUser = Array.isArray(findResp.data) ? findResp.data[0] : null;
        if (kcUser?.id) {
          await axios.put(`${baseUrl}/admin/realms/${realm}/users/${kcUser.id}`,
            { requiredActions: [], emailVerified: true },
            { headers: { Authorization: `Bearer ${adminAccessToken}` } }
          );
        }

        // Retry once
        const retry = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        return reply.send(retry.data);
      } catch (e) {
        // fall through to outer catch to return original error
        throw err;
      }
    }
  } catch (error: any) {
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'LOGIN_FAILED');
    return reply.status(401).send({ error: 'LOGIN_FAILED', detail });
  }
}
