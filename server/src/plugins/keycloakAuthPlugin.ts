import fp from 'fastify-plugin';
import { importSPKI, jwtVerify, decodeJwt, type CryptoKey } from 'jose';
import type { JWTVerifyOptions } from 'jose';

export default fp(async (fastify) => {
  // Test bypass: allow tests to inject auth without real Keycloak
  if (process.env.KEYCLOAK_AUTH_BYPASS === 'true') {
    fastify.decorateRequest('auth', null as any);
    fastify.addHook('preHandler', async (request) => {
      const azp = request.headers['x-test-azp'] as string | undefined;
      const sub = request.headers['x-test-sub'] as string | undefined;
      const aud = request.headers['x-test-aud'] as string | undefined;
      if (azp || sub || aud) {
        (request as any).auth = { azp, sub, aud };
      }
    });
    return;
  }

  // Phase 2.6 single-issuer cutover: only accept tokens we issue ourselves.
  // The previous dual-issuer mode lazily fetched Keycloak JWKS, which hangs
  // for ~30s when auth-service is offline (TCP timeout on a now-unresolvable
  // hostname). Single-issuer mode does no outbound HTTP and fast-rejects any
  // token that wasn't minted by user-service.
  const SELF_ISSUER = process.env.JWT_ISSUER?.trim();
  const SELF_PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY?.trim();
  if (!SELF_ISSUER || !SELF_PUBLIC_KEY_PEM) {
    fastify.log.error('Missing JWT_ISSUER or JWT_PUBLIC_KEY env vars — single-issuer auth requires both');
    throw new Error('Self-issued JWT configuration missing');
  }
  const SELF_KEY = (await importSPKI(SELF_PUBLIC_KEY_PEM, 'RS256')) as CryptoKey;
  fastify.log.info({ SELF_ISSUER }, '[user-service] Single-issuer mode: only accepting self-issued tokens');

  const audienceEnv = process.env.KEYCLOAK_AUDIENCE || process.env.KEYCLOAK_ALLOWED_AUDIENCES || '';
  const allowedAudiences = audienceEnv.split(',').map(s => s.trim()).filter(Boolean);

  const CLOCK_TOLERANCE_SECONDS = Number(process.env.KEYCLOAK_CLOCK_TOLERANCE_SECONDS || 60);

  fastify.decorateRequest('auth', null as any);

  fastify.addHook('preHandler', async (request, reply) => {
    if (reply.sent) return;
    try {
      // Try to get token from Authorization header first
      let token: string | null = null;
      const header = request.headers['authorization'];
      if (header && typeof header === 'string' && header.startsWith('Bearer ')) {
        token = header.substring(7).trim();
      }

      // Fallback to cookie if no Authorization header (for cookie-based SSO)
      if (!token && request.cookies && request.cookies['accessToken']) {
        token = request.cookies['accessToken'];
        fastify.log.debug('[user-service] Using access token from cookie');
      }

      // If no token at all, allow unauthenticated (permissive mode)
      if (!token) {
        request.auth = undefined;
        return;
      }

      if (process.env.NODE_ENV !== 'production') {
        try {
          const decoded = decodeJwt(token);
          fastify.log.debug({ iss: decoded.iss, azp: decoded.azp, aud: decoded.aud, exp: decoded.exp, sub: decoded.sub }, 'Decoded token (no signature verification)');
        } catch {}
      }

      // Fast reject: if iss isn't ours, don't even try to verify. This is the
      // critical guard that prevents hanging on the legacy KEYCLOAK_JWKS fetch.
      let tokenIss: string | undefined;
      try { tokenIss = decodeJwt(token).iss; } catch {}
      if (!tokenIss || tokenIss !== SELF_ISSUER) {
        return reply.status(401).send({ error: 'INVALID_OR_LEGACY_TOKEN' });
      }

      const verifyOptions: JWTVerifyOptions = { issuer: SELF_ISSUER, clockTolerance: CLOCK_TOLERANCE_SECONDS };
      const { payload } = await jwtVerify(token, SELF_KEY, verifyOptions);

      if (allowedAudiences.length > 0) {
        const audClaim = payload.aud;
        const azpClaim: unknown = (payload as any).azp;
        const audList: string[] = Array.isArray(audClaim) ? audClaim as string[] : typeof audClaim === 'string' ? [audClaim] : [];
        const azpList: string[] = typeof azpClaim === 'string' ? [azpClaim] : Array.isArray(azpClaim) ? azpClaim as string[] : [];
        const combined = [...audList, ...azpList];
        if (!combined.some(v => allowedAudiences.includes(v)))
          return reply.status(401).send({ error: 'Invalid audience' });
      }

      request.auth = payload;
      return;
    } catch (err) {
      fastify.log.debug({ err }, 'JWT verification failed');
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
  });
});
