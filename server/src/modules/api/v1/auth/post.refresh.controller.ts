import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  getCookieDomain,
  getAccessTokenCookieOptions,
  getRefreshTokenCookieOptions,
} from '../../../../lib/cookie-domain.js';
import { postRefreshService } from './post.refresh.service.js';

/**
 * Sets authentication cookies with proper domain configuration for SSO
 * Automatically detects cookie domain based on request hostname
 * Supports multiple brands: .returnacy.app, .chepizzadasalva.it, custom domains
 */
function setCrossDomainAuthCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  tokens: { access_token: string; refresh_token?: string }
): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const cookieDomain = getCookieDomain(request);

  request.server.log.info(
    { cookieDomain, isProduction, hostname: request.hostname },
    'Setting SSO auth cookies'
  );

  // Access token: short-lived, can be read by JavaScript for API calls
  reply.setCookie('accessToken', tokens.access_token, getAccessTokenCookieOptions(cookieDomain, isProduction));

  // Refresh token: only update if a new one was issued
  if (tokens.refresh_token) {
    reply.setCookie('refreshToken', tokens.refresh_token, getRefreshTokenCookieOptions(cookieDomain, isProduction));
  }
}

export async function postRefreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postRefreshService(request);

  // Set SSO cookies if refresh was successful
  if (result.statusCode === 200 && result.body) {
    const tokens = result.body as any;
    if (tokens.access_token) {
      setCrossDomainAuthCookies(request, reply, tokens);
    }
  }

  return reply.status(result.statusCode).send(result.body);
}
