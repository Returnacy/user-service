import fp from 'fastify-plugin';
import { createRemoteJWKSet, importSPKI, jwtVerify, decodeJwt, type CryptoKey } from 'jose';
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
  const KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL;
  const REALM = process.env.KEYCLOAK_REALM;
  if (!KEYCLOAK_BASE_URL || !REALM) {
    fastify.log.error('Missing KEYCLOAK_BASE_URL or KEYCLOAK_REALM env vars');
    throw new Error('Keycloak configuration missing');
  }

  const jwksUrl = `${KEYCLOAK_BASE_URL}/realms/${REALM}/protocol/openid-connect/certs`;
  const KEYCLOAK_JWKS = createRemoteJWKSet(new URL(jwksUrl));

  // Phase 2.6 — also trust tokens we issue ourselves (same shape as consumer
  // services' dual-issuer plugin). When JWT_ISSUER and JWT_PUBLIC_KEY are set,
  // self-issued tokens are verified against the local public key directly.
  const SELF_ISSUER = process.env.JWT_ISSUER?.trim();
  const SELF_PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY?.trim();
  let SELF_KEY: CryptoKey | null = null;
  if (SELF_ISSUER && SELF_PUBLIC_KEY_PEM) {
    try {
      SELF_KEY = (await importSPKI(SELF_PUBLIC_KEY_PEM, 'RS256')) as CryptoKey;
      fastify.log.info({ SELF_ISSUER }, '[user-service] Dual-issuer mode: also accepting self-issued tokens');
    } catch (e) {
      fastify.log.error({ err: e }, '[user-service] Failed to import JWT_PUBLIC_KEY for self-verification');
    }
  }

  const configuredIssuersEnv = process.env.KEYCLOAK_ISSUER;
  const baseIssuers: string[] = configuredIssuersEnv
    ? configuredIssuersEnv.split(',').map(s => s.trim())
    : [
        `${KEYCLOAK_BASE_URL}/realms/${REALM}`,
        'http://localhost:8080/realms/' + REALM,
        'http://keycloak:8080/realms/' + REALM
      ];
  const validIssuers: string[] = SELF_KEY && SELF_ISSUER
    ? [...baseIssuers, SELF_ISSUER]
    : baseIssuers;

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

      let tokenIss: string | undefined;
      try { tokenIss = decodeJwt(token).iss; } catch {}

      const verifyOptions: any = { issuer: validIssuers, clockTolerance: CLOCK_TOLERANCE_SECONDS } as JWTVerifyOptions;

      const useSelfKey = SELF_KEY && tokenIss && tokenIss === SELF_ISSUER;
      const { payload } = useSelfKey
        ? await jwtVerify(token, SELF_KEY!, verifyOptions)
        : await jwtVerify(token, KEYCLOAK_JWKS, verifyOptions);

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
