import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';

const refreshSchema = z.object({ refreshToken: z.string().min(1).optional() });

type RefreshResponse = Record<string, unknown> & { access_token?: string };

export async function postRefreshService(request: FastifyRequest): Promise<ServiceResponse<RefreshResponse>> {
  try {
    // Try to get refresh token from:
    // 1. Request body (for backwards compatibility)
    // 2. HttpOnly cookie (for SSO)
    const bodyData = refreshSchema.parse(request.body);
    const cookieToken = (request.cookies as any)?.refreshToken;
    const refreshToken = bodyData.refreshToken || cookieToken;

    if (!refreshToken) {
      return { statusCode: 401, body: { error: 'MISSING_REFRESH_TOKEN' } };
    }

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
