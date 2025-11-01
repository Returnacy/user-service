import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';

const logoutSchema = z.object({ refreshToken: z.string().min(1) });

type LogoutResponse = { ok: true } | { error: string };

export async function postLogoutService(request: FastifyRequest): Promise<ServiceResponse<LogoutResponse>> {
  try {
    const { refreshToken } = logoutSchema.parse(request.body);
    const url = `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/logout`;
    const clientId = process.env.KEYCLOAK_PUBLIC_CLIENT_ID || 'frontend-spa';

    const form = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken });
    await axios.post(url, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'LOGOUT_FAILED' } };
  }
}
