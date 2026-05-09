import type { FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { verifyGoogleIdToken } from '@/utils/googleIdentity.js';
import { resolveDomain } from '@/utils/domainMapping.js';
import { ensureDomainMembership } from '@/utils/membershipSync.js';
import { mintTokenPair, useLocalPasswordVerification, type AccessTokenClaims } from '@/utils/selfIssuedJwt.js';

const legacyLoginSchema = z.object({
  username: z.email(),
  password: z.string().min(1)
});

const passwordLoginSchema = z.object({
  authType: z.literal('password'),
  email: z.email(),
  password: z.string().min(1)
});

const oauthLoginSchema = z.object({
  authType: z.literal('oauth'),
  provider: z.literal('google'),
  idToken: z.string().min(10)
});

type TokenService = { getAccessToken(opts?: { mode?: 'service' | 'admin'; scope?: string }): Promise<string> };

type ServicePayload = Record<string, unknown>;

function safeDetail(err: unknown): string {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err.slice(0, 500);
  if (err instanceof Error) return (err.message || 'Error').slice(0, 500);
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return 'Error';
  }
}

function buildClaims(user: { keycloakSub: string; email: string; name?: string | null; surname?: string | null }): AccessTokenClaims {
  const fullName = `${user.name ?? ''} ${user.surname ?? ''}`.trim();
  const claims: AccessTokenClaims = {
    sub: user.keycloakSub,
    email: user.email,
    email_verified: true,
    preferred_username: user.email,
  };
  if (user.name) claims.given_name = user.name;
  if (user.surname) claims.family_name = user.surname;
  if (fullName) claims.name = fullName;
  return claims;
}

export async function postLoginService(request: FastifyRequest): Promise<ServiceResponse<ServicePayload>> {
  try {
    const rawBody = (request.body ?? {}) as any;

    if (rawBody?.authType === 'oauth') {
      const oauthInput = oauthLoginSchema.parse(rawBody);
      if (oauthInput.provider !== 'google') {
        return { statusCode: 400, body: { error: 'UNSUPPORTED_OAUTH_PROVIDER' } };
      }

      const repository = (request.server as any).repository;
      const tokenService = (request.server as any).keycloakTokenService as TokenService;
      const googlePayload = await verifyGoogleIdToken(oauthInput.idToken);
      const googleSub = googlePayload.sub;
      const emailFromGoogle = (googlePayload.email || '').toLowerCase();
      const email = emailFromGoogle || (typeof rawBody.email === 'string' ? rawBody.email.toLowerCase() : '');

      // Resolve brand/business context from request headers (matches register flow)
      const xfh = request.headers['x-forwarded-host'] as string | undefined;
      const host = request.headers['host'] as string | undefined;
      const origin = request.headers['origin'] as string | undefined;
      const referer = request.headers['referer'] as string | undefined;
      let originHost = '';
      try { if (origin) originHost = new URL(origin).host; } catch {}
      let refererHost = '';
      try { if (referer) refererHost = new URL(referer).host; } catch {}
      const [fromHost, fromXfh, fromOrigin, fromReferer] = await Promise.all([
        host ? resolveDomain(host) : Promise.resolve(null),
        xfh ? resolveDomain(xfh) : Promise.resolve(null),
        originHost ? resolveDomain(originHost) : Promise.resolve(null),
        refererHost ? resolveDomain(refererHost) : Promise.resolve(null),
      ]);
      const domain = fromHost || fromXfh || fromOrigin || fromReferer;

      let user = googleSub ? await repository.findUserByGoogleSub(googleSub) : null;
      if (!user && email) {
        if (domain?.businessId || domain?.brandId) {
          // Prefer scoped lookup to avoid cross-brand account linking/overwrite
          let scoped: any = null;
          if (domain.businessId) {
            scoped = await repository.findUserByEmailAndBusiness(email, domain.businessId);
          }
          if (!scoped && domain.brandId) {
            scoped = await repository.findUserByEmailAndBrand(email, domain.brandId);
          }
          if (scoped) {
            user = scoped;
            if (googleSub && !(user as any).googleSub) {
              await repository.upsertUserByKeycloakSub(user.keycloakSub, { googleSub });
              user = await repository.findUserByKeycloakSub(user.keycloakSub);
            }
          } else {
            // If an account with same email exists for another brand, add membership for current brand/business
            const existingAny = await repository.findUserByEmail(email);
            if (existingAny && (domain.brandId || domain.businessId)) {
              if (googleSub && !(existingAny as any).googleSub) {
                await repository.upsertUserByKeycloakSub(existingAny.keycloakSub, { googleSub });
              }
              try {
                await repository.upsertMembership(existingAny.id, {
                  businessId: domain.businessId,
                  brandId: domain.brandId ?? null,
                  role: 'USER'
                });
              } catch (mErr) {
                request.log.warn({ mErr }, 'Failed to upsert membership for existing user');
              }
              user = await repository.findUserByKeycloakSub(existingAny.keycloakSub);
            }
            // Else, fall through: user remains null -> handled below (404 register-first)
          }
        } else {
          // No domain context; fallback to legacy behavior
          user = await repository.findUserByEmail(email);
          if (user && googleSub && !(user as any).googleSub) {
            await repository.upsertUserByKeycloakSub(user.keycloakSub, { googleSub });
            user = await repository.findUserByKeycloakSub(user.keycloakSub);
          }
        }
      }

      if (!user) {
        return {
          statusCode: 404,
          body: { error: 'USER_NOT_FOUND', message: 'Registrati con Google prima di effettuare l\'accesso.' }
        };
      }

      const membershipAttrs: Record<string, unknown> | undefined = googleSub
        ? { googleSub: [googleSub], signupProvider: ['google'] }
        : undefined;
      if (domain || membershipAttrs) {
        try {
          await ensureDomainMembership({
            repository,
            tokenService,
            user: { id: user.id, keycloakSub: user.keycloakSub },
            domain,
            logger: request.log,
            ...(membershipAttrs ? { extraAttributes: membershipAttrs } : {}),
          });
        } catch (err) {
          request.log.error({ err, userId: user.id, domain }, 'Failed to ensure membership for Google login');
        }
      }

      const tokens = await mintTokenPair(buildClaims(user));
      return {
        statusCode: 200,
        body: {
          ...tokens,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          user: { id: user.id, keycloakSub: user.keycloakSub, email: user.email },
        },
      };
    }

    // Password login (legacy schema with username, or new authType=password)
    const credentials = rawBody?.authType === 'password'
      ? passwordLoginSchema.parse(rawBody)
      : legacyLoginSchema.parse(rawBody);

    const isPasswordVariant = (credentials as any).authType === 'password';
    const username = isPasswordVariant ? (credentials as any).email : (credentials as any).username;
    const password = (credentials as any).password;

    if (!useLocalPasswordVerification()) {
      // Local password verification is the only supported auth path now.
      // The flag must be on; the legacy Keycloak fallback was removed in Phase 2.6.
      request.log.error('USE_LOCAL_PASSWORD_VERIFICATION is not enabled; password login cannot proceed');
      return { statusCode: 503, body: { error: 'AUTH_NOT_CONFIGURED' } };
    }

    const repository = (request.server as any).repository as any;
    const localUser = await repository.findUserByEmail(username);
    if (!localUser?.passwordHash) {
      request.log.info({ username }, 'Password login attempt for user without local passwordHash');
      return { statusCode: 401, body: { error: 'INVALID_CREDENTIALS' } };
    }
    const valid = await bcrypt.compare(password, localUser.passwordHash);
    if (!valid) {
      request.log.info({ username }, 'Local password verification failed');
      return { statusCode: 401, body: { error: 'INVALID_CREDENTIALS' } };
    }
    request.log.info({ username, sub: localUser.keycloakSub }, 'Local password verification succeeded');
    const tokens = await mintTokenPair(buildClaims(localUser));
    return { statusCode: 200, body: tokens };
  } catch (error: any) {
    const status = error?.statusCode ?? error?.response?.status ?? 401;
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'LOGIN_FAILED');
    return {
      statusCode: status,
      body: {
        error: 'LOGIN_FAILED',
        message: safeDetail(detail),
        detail,
      },
    };
  }
}
