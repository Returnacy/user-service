import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import crypto from 'node:crypto';
import { z } from 'zod';
import { resolveDomain } from '../../utils/domainMapping.js';
import { registerSchema } from '@user-service/types';
import { verifyGoogleIdToken } from '../../utils/googleIdentity.js';

const oauthRegisterSchema = z.object({
  authType: z.literal('oauth'),
  provider: z.literal('google'),
  idToken: z.string().min(10),
  email: z.string().email(),
  name: z.string().min(1),
  surname: z.string().min(1),
  birthday: z.string().min(4),
  phone: z.string().optional(),
  gender: z.string().optional(),
  acceptTermsOfService: z.boolean(),
  acceptPrivacyPolicy: z.boolean(),
  acceptMarketing: z.boolean().optional(),
});

function buildTokenUrl() {
  return `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
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

export async function postRegisterHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const DEBUG = process.env.DEBUG_MEMBERSHIP === '1';
    const dbg = (data: any, msg: string) => {
      if (DEBUG) request.log.info({ tag: 'membership.debug', ...data }, msg);
    };
    // Normalize legacy aliases sent by some frontends
    const raw = (request.body ?? {}) as any;
    const normalized: any = { ...raw };
    if (normalized.birthdate && !normalized.birthday) normalized.birthday = normalized.birthdate;
    if (normalized.acceptedTermsAndConditions !== undefined && normalized.acceptTermsOfService === undefined) {
      normalized.acceptTermsOfService = !!normalized.acceptedTermsAndConditions;
    }
    if (normalized.acceptedPrivacyPolicy !== undefined && normalized.acceptPrivacyPolicy === undefined) {
      normalized.acceptPrivacyPolicy = !!normalized.acceptedPrivacyPolicy;
    }
    if (normalized.acceptedMarketingPolicy !== undefined && normalized.acceptMarketing === undefined) {
      normalized.acceptMarketing = !!normalized.acceptedMarketingPolicy;
    }
    const authType = normalized.authType === 'oauth' ? 'oauth' : 'password';
    const repository = (request.server as any).repository as { upsertUserByKeycloakSub: Function };
    const tokenService = (request.server as any).keycloakTokenService as { getAccessToken: () => Promise<string> };

    const accessToken = await tokenService.getAccessToken();
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;

    const passwordInput = authType === 'password' ? registerSchema.parse(normalized) : null;
    const oauthInput = authType === 'oauth' ? oauthRegisterSchema.parse(normalized) : null;

    let googlePayload: Awaited<ReturnType<typeof verifyGoogleIdToken>> | null = null;
    let googleSub: string | null = null;
    if (oauthInput) {
      googlePayload = await verifyGoogleIdToken(oauthInput.idToken);
      googleSub = googlePayload.sub;
      if (!googleSub) {
        return reply.status(400).send({ error: 'GOOGLE_SUB_MISSING' });
      }
      if (googlePayload.email_verified === false) {
        return reply.status(400).send({ error: 'GOOGLE_EMAIL_NOT_VERIFIED' });
      }
    }

    const resolvedEmail = (() => {
      if (oauthInput) {
        const googleEmail = (googlePayload?.email || '').toLowerCase();
        return (googleEmail || oauthInput.email).toLowerCase();
      }
      return passwordInput!.email.toLowerCase();
    })();

    const resolvedName = (() => {
      if (!oauthInput) return passwordInput!.name;
      const fromBody = oauthInput.name?.trim();
      if (fromBody) return oauthInput.name;
      return googlePayload?.given_name || googlePayload?.name || oauthInput.email.split('@')[0] || 'Utente';
    })();

    const resolvedSurname = (() => {
      if (!oauthInput) return passwordInput!.surname;
      const fromBody = oauthInput.surname?.trim();
      if (fromBody) return oauthInput.surname;
      return googlePayload?.family_name || '';
    })();

    const registerData = {
      email: resolvedEmail,
      name: resolvedName,
      surname: resolvedSurname,
      birthday: oauthInput ? oauthInput.birthday : passwordInput!.birthday,
      phone: oauthInput ? oauthInput.phone ?? undefined : passwordInput!.phone ?? undefined,
      gender: oauthInput ? oauthInput.gender ?? null : passwordInput!.gender ?? null,
      acceptTermsOfService: oauthInput ? oauthInput.acceptTermsOfService : passwordInput!.acceptTermsOfService,
      acceptPrivacyPolicy: oauthInput ? oauthInput.acceptPrivacyPolicy : passwordInput!.acceptPrivacyPolicy,
      acceptMarketing: oauthInput ? (oauthInput.acceptMarketing ?? false) : passwordInput!.acceptMarketing ?? false,
    };

    const loginPassword = oauthInput ? crypto.randomBytes(24).toString('hex') : passwordInput!.password;

    // 1) Create user in Keycloak
    const attributes: any = {};
    // derive default membership from domain mapping using host headers
    const xfh = request.headers['x-forwarded-host'] as string | undefined;
    const host = request.headers['host'] as string | undefined;
    const origin = request.headers['origin'] as string | undefined;
    const referer = request.headers['referer'] as string | undefined;
    let originHost = '';
    try { if (origin) originHost = new URL(origin).host; } catch {}
    let refererHost = '';
    try { if (referer) refererHost = new URL(referer).host; } catch {}
    const resolvedFromHost = host ? resolveDomain(host) : null;
    const resolvedFromXfh = xfh ? resolveDomain(xfh) : null;
    const resolvedFromOrigin = originHost ? resolveDomain(originHost) : null;
    const resolvedFromReferer = refererHost ? resolveDomain(refererHost) : null;
    const domain = resolvedFromHost || resolvedFromXfh || resolvedFromOrigin || resolvedFromReferer;

    dbg({ xfh, host, origin, referer, originHost, refererHost, resolvedFromHost, resolvedFromXfh, resolvedFromOrigin, resolvedFromReferer }, 'Resolved domain candidates');

    const defaultMembership = domain ? [{ brandId: domain.brandId ?? null, businessId: domain.businessId, roles: ['user'] }] : [];
    dbg({ defaultMembership }, 'Computed defaultMembership');

    if (registerData.phone) {
      // Match Keycloak realm mapper expecting user attribute 'phoneNumber'
      attributes.phoneNumber = registerData.phone;
    }

    attributes.memberships = [JSON.stringify(defaultMembership)];
    if (googleSub) {
      attributes.googleSub = [googleSub];
      attributes.signupProvider = ['google'];
    }
    dbg({ attributes }, 'Keycloak attributes payload');

    const kcResp = await axios.post(
      `${baseUrl}/admin/realms/${realm}/users`,
      {
        username: registerData.email,
        email: registerData.email,
        enabled: true,
        // Mark email as verified to avoid required actions blocking direct grant login
        emailVerified: true,
        firstName: registerData.name,
        lastName: registerData.surname,
        attributes
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    dbg({ status: kcResp.status, headers: { location: kcResp.headers['location'] } }, 'Keycloak create user response');

    // location header contains user id
    const location = kcResp.headers['location'] as string | undefined;
    let keycloakId: string | undefined;
    if (location) {
      const parts = location.split('/');
      keycloakId = parts[parts.length - 1];
    }

    if (!keycloakId) {
      // fallback: search by email to retrieve ID
      const findResp = await axios.get(
    `${baseUrl}/admin/realms/${realm}/users`,
    { params: { email: registerData.email }, headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const user = Array.isArray(findResp.data) ? findResp.data[0] : null;
      keycloakId = user?.id;
    }

    if (!keycloakId) return reply.status(500).send({ error: 'KEYCLOAK_USER_CREATION_FAILED' });

    // 1a) Clear any required actions that might block direct access grant (e.g., VERIFY_EMAIL)
    try {
      await axios.put(
        `${baseUrl}/admin/realms/${realm}/users/${keycloakId}`,
        { requiredActions: [], emailVerified: true },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch (e) {
      request.log.warn({ err: e }, 'Failed to clear Keycloak required actions; proceeding');
    }

    // 1b) Set user password via reset-password endpoint (more compatible across KC versions)
    await axios.put(
    `${baseUrl}/admin/realms/${realm}/users/${keycloakId}/reset-password`,
    { type: 'password', temporary: false, value: loginPassword },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // 2) Fetch user to get subject (id is sub)
    const userInfoResp = await axios.get(
      `${baseUrl}/admin/realms/${realm}/users/${keycloakId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const kcUser = userInfoResp.data as any;
    const kcSub: string = kcUser.id;

    // 3) Upsert local user
    const dbUser = await (repository as any).upsertUserByKeycloakSub(kcSub, {
      email: registerData.email,
      name: registerData.name,
      surname: registerData.surname,
      birthday: registerData.birthday,
      gender: registerData.gender ?? null,
      userTermsAcceptance: registerData.acceptTermsOfService,
      userPrivacyPolicyAcceptance: registerData.acceptPrivacyPolicy,
      googleSub: googleSub ?? undefined,
    });

    // Create local membership based on domain if present
    if (domain) {
      dbg({ domain }, 'Upserting local membership derived from domain');
      await (repository as any).upsertMembership(dbUser.id, { businessId: domain.businessId, brandId: domain.brandId, role: 'USER' });
    } else {
      dbg({}, 'No domain-derived membership available; skipping local membership upsert');
    }

    // Save acceptances (latest versions if exist)
    const ip = (request.headers['x-forwarded-for'] as string) || request.ip;
    const ua = request.headers['user-agent'] as string | undefined;
    const latestPP = await (repository as any).getLatestPrivacyPolicyVersion();
    const latestTOS = await (repository as any).getLatestTermsOfServiceVersion();
    const latestMT = await (repository as any).getLatestMarketingTermsVersion();
    if (registerData.acceptPrivacyPolicy && latestPP) await (repository as any).createPrivacyPolicyAcceptance(dbUser.id, latestPP, ip, ua);
    if (registerData.acceptTermsOfService && latestTOS) await (repository as any).createTermsOfServiceAcceptance(dbUser.id, latestTOS, ip, ua);
    if (registerData.acceptMarketing && latestMT) await (repository as any).createMarketingTermsAcceptance(dbUser.id, latestMT, ip, ua);

    try {
      const tokenRes = await issuePasswordGrant(registerData.email, loginPassword);
      const tokens = tokenRes.data;
      return reply.send({
        ...tokens,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        user: {
          id: dbUser.id,
          keycloakSub: kcSub,
          email: dbUser.email,
        },
      });
    } catch (tokenErr: any) {
      request.log.error({ err: tokenErr }, 'Failed to issue tokens after registration');
      return reply.send({ id: dbUser.id, keycloakSub: kcSub, email: dbUser.email });
    }
  } catch (error: any) {
    // Improve error logging diagnostics from Keycloak admin API
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'Registration failed');
    // Map 409 conflicts (user exists) to a clearer message
    if (error?.response?.status === 409) {
      return reply.status(409).send({ error: 'EMAIL_ALREADY_EXISTS', detail });
    }
    return reply.status(400).send({ error: 'REGISTRATION_FAILED', detail });
  }
}
