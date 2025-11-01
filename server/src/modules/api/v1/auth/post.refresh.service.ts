import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

type RefreshResponse = Record<string, unknown> & { access_token?: string };

export async function postRefreshService(request: FastifyRequest): Promise<ServiceResponse<RefreshResponse>> {
  try {
    const { refreshToken } = refreshSchema.parse(request.body);

    const tokenUrl = `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.KEYCLOAK_CLIENT_ID!,
      client_secret: process.env.KEYCLOAK_CLIENT_SECRET!,
    });

    const res = await axios.post(tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return { statusCode: 200, body: res.data };
  } catch (error: any) {
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'REFRESH_FAILED');
    return { statusCode: 401, body: { error: 'REFRESH_FAILED', detail } };
  }
}
