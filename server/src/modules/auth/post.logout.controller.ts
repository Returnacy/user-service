import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { z } from 'zod';

const logoutSchema = z.object({ refreshToken: z.string().min(1) });

export async function postLogoutHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { refreshToken } = logoutSchema.parse(request.body);
    const url = `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/logout`;
    const clientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || 'frontend-spa';

    const form = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken });
    await axios.post(url, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return reply.send({ ok: true });
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return reply.status(400).send({ error: 'LOGOUT_FAILED' });
  }
}
