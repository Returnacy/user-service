import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import {
  isSelfIssuedToken,
  verifySelfIssuedToken,
  mintTokenPair,
} from '@/utils/selfIssuedJwt.js';

const refreshSchema = z.object({ refreshToken: z.string().min(1).optional() });

type RefreshResponse = Record<string, unknown> & { access_token?: string };

export async function postRefreshService(request: FastifyRequest): Promise<ServiceResponse<RefreshResponse>> {
  try {
    const bodyData = refreshSchema.parse(request.body);
    const cookieToken = (request.cookies as any)?.refreshToken;
    const refreshToken = bodyData.refreshToken || cookieToken;

    if (!refreshToken) {
      return { statusCode: 401, body: { error: 'MISSING_REFRESH_TOKEN' } };
    }

    if (isSelfIssuedToken(refreshToken)) {
      try {
        const { payload } = await verifySelfIssuedToken(refreshToken);
        if (payload.typ && payload.typ !== 'Refresh') {
          return { statusCode: 401, body: { error: 'INVALID_REFRESH_TOKEN_TYPE' } };
        }
        if (!payload.sub) {
          return { statusCode: 401, body: { error: 'INVALID_REFRESH_TOKEN_SUBJECT' } };
        }
        const tokens = await mintTokenPair({ sub: payload.sub as string });
        return { statusCode: 200, body: tokens };
      } catch (err) {
        request.log.warn({ err }, 'Self-issued refresh token verification failed');
        return { statusCode: 401, body: { error: 'REFRESH_FAILED' } };
      }
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
