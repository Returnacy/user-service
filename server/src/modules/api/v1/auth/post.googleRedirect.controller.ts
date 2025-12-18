import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  getCookieDomain,
  getAccessTokenCookieOptions,
  getRefreshTokenCookieOptions,
} from '../../../../lib/cookie-domain.js';
import { postLoginService } from './post.login.service.js';

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isAllowedRedirectHost(host: string, allowed: string[]): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return allowed.some((suffix) => {
    const s = suffix.toLowerCase();
    return h === s || h.endsWith(`.${s}`);
  });
}

function safeErrorMessage(err: unknown): string {
  if (!err) return 'UNKNOWN_ERROR';
  if (typeof err === 'string') return err.slice(0, 200);
  if (err instanceof Error) return err.message.slice(0, 200) || 'ERROR';
  try {
    return JSON.stringify(err).slice(0, 200);
  } catch {
    return 'ERROR';
  }
}

export async function postGoogleRedirectHandler(request: FastifyRequest, reply: FastifyReply) {
  // OAuth popups rely on window relationships; overly strict COOP can break postMessage.
  // If upstream (Cloudflare/Railway) doesn't override, these headers keep popups working.
  reply.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  reply.header('Cross-Origin-Embedder-Policy', 'unsafe-none');
  reply.header('Cache-Control', 'no-store');

  const allowedHosts = splitCsv(process.env.OAUTH_REDIRECT_ALLOWED_HOSTS);
  const fallbackAllowed = allowedHosts.length > 0 ? allowedHosts : ['chepizzadasalva.it', 'returnacy.app', 'localhost'];

  const query: any = request.query || {};
  const redirectUriRaw = typeof query.redirect_uri === 'string' ? query.redirect_uri : undefined;

  let redirectUri: URL | null = null;
  if (redirectUriRaw) {
    try {
      const parsed = new URL(redirectUriRaw);
      if (isAllowedRedirectHost(parsed.hostname, fallbackAllowed)) {
        redirectUri = parsed;
      }
    } catch {
      // ignore
    }
  }

  // If redirect_uri is missing/invalid, try to use Referer origin as a safe fallback.
  if (!redirectUri) {
    const referer = request.headers['referer'] as string | undefined;
    if (referer) {
      try {
        const parsed = new URL(referer);
        if (isAllowedRedirectHost(parsed.hostname, fallbackAllowed)) {
          redirectUri = new URL('/auth', parsed.origin);
        }
      } catch {
        // ignore
      }
    }
  }

  // Absolute last fallback: don't redirect off-site.
  if (!redirectUri) {
    const host = (request.headers['host'] as string | undefined) || 'localhost';
    redirectUri = new URL('/auth', `https://${host}`);
  }

  const body: any = request.body || {};
  const credential = typeof body.credential === 'string' ? body.credential : undefined;
  const idToken = typeof body.idToken === 'string' ? body.idToken : undefined;
  const token = credential || idToken;

  if (!token) {
    const next = new URL(redirectUri.toString());
    next.hash = new URLSearchParams({ error: 'MISSING_GOOGLE_CREDENTIAL' }).toString();
    return reply.redirect(next.toString());
  }

  try {
    // Reuse existing OAuth login service by shaping request.body.
    (request as any).body = { authType: 'oauth', provider: 'google', idToken: token };

    const result = await postLoginService(request);

    if (result.statusCode !== 200 || !result.body) {
      const errorCode = (result.body as any)?.error || 'LOGIN_FAILED';
      const next = new URL(redirectUri.toString());
      next.hash = new URLSearchParams({ error: String(errorCode) }).toString();
      return reply.redirect(next.toString());
    }

    const tokens: any = result.body;

    // Set cookies as usual (useful for same-origin and returnacy.app flows).
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieDomain = getCookieDomain(request);
    if (tokens.access_token) {
      reply.setCookie('accessToken', tokens.access_token, getAccessTokenCookieOptions(cookieDomain, isProduction));
    }
    if (tokens.refresh_token) {
      reply.setCookie('refreshToken', tokens.refresh_token, getRefreshTokenCookieOptions(cookieDomain, isProduction));
    }

    // Send tokens back to the SPA via URL hash (fragment) so they aren't sent to servers by the browser.
    const next = new URL(redirectUri.toString());
    next.hash = new URLSearchParams({
      accessToken: String(tokens.access_token || ''),
      refreshToken: String(tokens.refresh_token || ''),
    }).toString();

    return reply.redirect(next.toString());
  } catch (err) {
    const next = new URL(redirectUri.toString());
    next.hash = new URLSearchParams({ error: safeErrorMessage(err) }).toString();
    return reply.redirect(next.toString());
  }
}
