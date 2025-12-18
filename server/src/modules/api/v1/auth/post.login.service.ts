import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import crypto from 'node:crypto';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { verifyGoogleIdToken } from '@/utils/googleIdentity.js';
import { resolveDomain } from '@/utils/domainMapping.js';
import { ensureDomainMembership } from '@/utils/membershipSync.js';
import { buildUserAttributeUpdatePayload } from '@/utils/keycloak.js';


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

type TokenService = { getAccessToken(): Promise<string> };

function buildTokenUrl() {
  if (process.env.KEYCLOAK_TOKEN_URL) return process.env.KEYCLOAK_TOKEN_URL;
  return `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
}

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

async function issuePasswordGrant(username: string, password: string) {
  const tokenUrl = buildTokenUrl();
  const form = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    client_id: process.env.KEYCLOAK_CLIENT_ID!,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET!,
    scope: 'openid profile email offline_access'
  });
  return axios.post(tokenUrl, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

type ServicePayload = Record<string, unknown>;

type PrepareKeycloakUserOptions = {
  baseUrl: string;
  realm: string;
  userId: string;
  adminAccessToken: string;
};

async function prepareKeycloakUserForGoogleLogin(options: PrepareKeycloakUserOptions): Promise<void> {
  const { baseUrl, realm, userId, adminAccessToken } = options;
  await axios.put(
    `${baseUrl}/admin/realms/${realm}/users/${encodeURIComponent(userId)}`,
    { emailVerified: true, requiredActions: [] },
    { headers: { Authorization: `Bearer ${adminAccessToken}` } }
  );
}

export function isAccountNotFullySetupError(err: any): boolean {
  const status = err?.response?.status;
  if (status !== 400) return false;
  const data = err?.response?.data;
  const errorCode = typeof data?.error === 'string' ? data.error : '';
  const description = typeof data?.error_description === 'string' ? data.error_description : '';
  const normalizedDescription = description.toLowerCase();
  return errorCode === 'invalid_grant' || normalizedDescription.includes('not fully set up');
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

  // Resolve brand/business context from request headers (like in registration)
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
            // If an account with same email exists for another brand, add membership for current brand/business and sync Keycloak memberships
            const existingAny = await repository.findUserByEmail(email);
            if (existingAny && (domain.brandId || domain.businessId)) {
              // 1) Link googleSub to existing user if needed
              if (googleSub && !(existingAny as any).googleSub) {
                await repository.upsertUserByKeycloakSub(existingAny.keycloakSub, { googleSub });
              }

              // 2) Upsert membership in our DB for current domain
              try {
                await repository.upsertMembership(existingAny.id, {
                  businessId: domain.businessId,
                  brandId: domain.brandId ?? null,
                  role: 'USER'
                });
              } catch (mErr) {
                request.log.warn({ mErr }, 'Failed to upsert membership for existing user');
              }

              // 3) Update Keycloak memberships attribute to include new brand/business
              try {
                const adminAccessToken = await tokenService.getAccessToken();
                const baseUrl = process.env.KEYCLOAK_BASE_URL!;
                const realm = process.env.KEYCLOAK_REALM!;

                const kcGet = await axios.get(
                  `${baseUrl}/admin/realms/${realm}/users/${existingAny.keycloakSub}`,
                  { headers: { Authorization: `Bearer ${adminAccessToken}` } }
                );
                const kcUser = kcGet.data as any;
                const attrs = (kcUser?.attributes ?? {}) as Record<string, string[]>;
                const rawMemberships: string = (Array.isArray(attrs.memberships) && attrs.memberships.length > 0 && typeof attrs.memberships[0] === 'string') ? attrs.memberships[0] as unknown as string : '[]';
                let parsed: any[] = [];
                try {
                  const val = JSON.parse(rawMemberships);
                  if (Array.isArray(val)) parsed = val; else if (val && typeof val === 'object') parsed = [val];
                } catch (_) {
                  parsed = [];
                }

                const exists = parsed.some((m: any) => (m?.businessId === domain.businessId) || (domain.brandId && m?.brandId === domain.brandId));
                if (!exists) {
                  parsed.push({ brandId: domain.brandId ?? null, businessId: domain.businessId, roles: ['user'] });
                  const nextAttrs = {
                    ...attrs,
                    memberships: [JSON.stringify(parsed)]
                  } as Record<string, string[]>;
                  const payload = buildUserAttributeUpdatePayload(kcUser, nextAttrs);
                  await axios.put(
                    `${baseUrl}/admin/realms/${realm}/users/${existingAny.keycloakSub}`,
                    payload,
                    { headers: { Authorization: `Bearer ${adminAccessToken}` } }
                  );
                }
              } catch (kcErr) {
                request.log.warn({ kcErr }, 'Failed to update Keycloak memberships attribute');
              }

              // Treat as authenticated user from here
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

      const adminAccessToken = await tokenService.getAccessToken();
      const baseUrl = process.env.KEYCLOAK_BASE_URL!;
      const realm = process.env.KEYCLOAK_REALM!;

      try {
        await prepareKeycloakUserForGoogleLogin({
          baseUrl,
          realm,
          userId: user.keycloakSub,
          adminAccessToken,
        });
      } catch (err) {
        request.log.warn({ err }, 'Failed to prepare Keycloak user for Google login');
      }

      const tempPassword = crypto.randomBytes(24).toString('hex');
      try {
        await axios.put(
          `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}/reset-password`,
          { type: 'password', temporary: false, value: tempPassword },
          { headers: { Authorization: `Bearer ${adminAccessToken}` } }
        );
      } catch (err) {
        request.log.error({ err }, 'Failed to set temporary password for Google login');
        return { statusCode: 500, body: { error: 'GOOGLE_LOGIN_PASSWORD_RESET_FAILED' } };
      }

      const performPasswordGrant = async () => {
        const tokenRes = await issuePasswordGrant(user.email || email || emailFromGoogle, tempPassword);
        return tokenRes.data;
      };

      try {
        const tokens = await performPasswordGrant();
        return {
          statusCode: 200,
          body: {
            ...tokens,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            user: { id: user.id, keycloakSub: user.keycloakSub, email: user.email },
          },
        };
      } catch (err: any) {
        if (isAccountNotFullySetupError(err)) {
          request.log.warn({ err }, 'Keycloak reported account not fully set up during Google login; retrying');
          try {
            await prepareKeycloakUserForGoogleLogin({
              baseUrl,
              realm,
              userId: user.keycloakSub,
              adminAccessToken,
            });
            const tokens = await performPasswordGrant();
            return {
              statusCode: 200,
              body: {
                ...tokens,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                user: { id: user.id, keycloakSub: user.keycloakSub, email: user.email },
              },
            };
          } catch (retryErr: any) {
            request.log.error({ retryErr }, 'Failed to recover from Keycloak setup error during Google login');
          }
        }

        const detail = err?.response?.data || err?.message || 'Unknown error';
        request.log.error({ err, detail }, 'GOOGLE_LOGIN_TOKEN_EXCHANGE_FAILED');
        return { statusCode: 401, body: { error: 'GOOGLE_LOGIN_FAILED', detail } };
      }
    }

    const credentials = rawBody?.authType === 'password'
      ? passwordLoginSchema.parse(rawBody)
      : legacyLoginSchema.parse(rawBody);

    const isPasswordVariant = (credentials as any).authType === 'password';
    const username = isPasswordVariant ? (credentials as any).email : (credentials as any).username;
    const password = (credentials as any).password;

    try {
      const res = await issuePasswordGrant(username, password);
      const tokens = res.data;


      return { statusCode: 200, body: tokens };
    } catch (err: any) {
      const errData = err?.response?.data;
      const isRequiredActionsBlock = err?.response?.status === 400 && (
        errData?.error === 'invalid_grant' || errData?.error_description?.toLowerCase?.().includes('not fully set up')
      );
      if (!isRequiredActionsBlock) throw err;

      try {
        const adminTokenUrl = buildTokenUrl();
        const adminClientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? process.env.KEYCLOAK_CLIENT_ID;
        const adminClientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? process.env.KEYCLOAK_CLIENT_SECRET;

        if (!adminClientId || !adminClientSecret) {
          request.log.error(
            { hasAdminClientId: !!adminClientId, hasAdminClientSecret: !!adminClientSecret },
            'Missing Keycloak admin client credentials; cannot clear required actions'
          );
          throw err;
        }
        const adminBody = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: adminClientId,
          client_secret: adminClientSecret
        });
        const adminRes = await axios.post(adminTokenUrl, adminBody, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const adminAccessToken: string = adminRes.data.access_token;

        const baseUrl = process.env.KEYCLOAK_BASE_URL!;
        const realm = process.env.KEYCLOAK_REALM!;
        const findResp = await axios.get(`${baseUrl}/admin/realms/${realm}/users`, {
          params: { email: username },
          headers: { Authorization: `Bearer ${adminAccessToken}` }
        });
        const kcUser = Array.isArray(findResp.data) ? findResp.data[0] : null;
        if (kcUser?.id) {
          await axios.put(
            `${baseUrl}/admin/realms/${realm}/users/${kcUser.id}`,
            { requiredActions: [], emailVerified: true },
            { headers: { Authorization: `Bearer ${adminAccessToken}` } }
          );
        }

        const retry = await issuePasswordGrant(username, password);
        const retryTokens = retry.data;


        return { statusCode: 200, body: retryTokens };
      } catch (e) {
        throw err;
      }
    }
  } catch (error: any) {
    const status = error?.statusCode ?? error?.response?.status ?? 401;
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'LOGIN_FAILED');
    return {
      statusCode: status,
      body: {
        error: 'LOGIN_FAILED',
        // Many frontend callers only surface `message`, so include a compact detail string.
        message: safeDetail(detail),
        detail,
      },
    };
  }
}
