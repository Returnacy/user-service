import type { FastifyReply, FastifyRequest } from 'fastify';

import { getCookieDomain, getClearCookieOptions } from '../../../../lib/cookie-domain.js';
import { postLogoutService } from './post.logout.service.js';

/**
 * Clears authentication cookies across all domains
 * Automatically detects cookie domain based on request hostname
 * Supports multiple brands: .returnacy.app, .chepizzadasalva.it, custom domains
 */
function clearCrossDomainAuthCookies(request: FastifyRequest, reply: FastifyReply): void {
  const cookieDomain = getCookieDomain(request);

  request.server.log.info(
    { cookieDomain, hostname: request.hostname },
    'Clearing SSO auth cookies'
  );

  const clearOptions = getClearCookieOptions(cookieDomain);

  // Clear access token
  reply.clearCookie('accessToken', clearOptions);

  // Clear refresh token
  reply.clearCookie('refreshToken', clearOptions);
}

export async function postLogoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const result = await postLogoutService(request);

  // Always clear cookies on logout, even if Keycloak logout failed
  clearCrossDomainAuthCookies(request, reply);

  return reply.status(result.statusCode).send(result.body);
}
