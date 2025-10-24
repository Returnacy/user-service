import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { resolveDomain } from '../../utils/domainMapping.js';
import { registerSchema } from '@user-service/types';

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
    const input = registerSchema.parse(normalized);
    const repository = (request.server as any).repository as { upsertUserByKeycloakSub: Function };
    const tokenService = (request.server as any).keycloakTokenService as { getAccessToken: () => Promise<string> };

    const accessToken = await tokenService.getAccessToken();
    const baseUrl = process.env.KEYCLOAK_BASE_URL!;
    const realm = process.env.KEYCLOAK_REALM!;

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

    if (input.phone) {
      // Match Keycloak realm mapper expecting user attribute 'phoneNumber'
      attributes.phoneNumber = input.phone;
    }

  attributes.memberships = [JSON.stringify(defaultMembership)];
  dbg({ attributes }, 'Keycloak attributes payload');

    const kcResp = await axios.post(
      `${baseUrl}/admin/realms/${realm}/users`,
      {
        username: input.email,
        email: input.email,
        enabled: true,
        // Mark email as verified to avoid required actions blocking direct grant login
        emailVerified: true,
        firstName: input.name,
        lastName: input.surname,
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
        { params: { email: input.email }, headers: { Authorization: `Bearer ${accessToken}` } }
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
      { type: 'password', temporary: false, value: input.password },
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
      email: input.email,
      name: input.name,
      surname: input.surname,
      birthday: input.birthday,
      gender: input.gender ?? null,
      userTermsAcceptance: input.acceptTermsOfService,
      userPrivacyPolicyAcceptance: input.acceptPrivacyPolicy,
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
    if (input.acceptPrivacyPolicy && latestPP) await (repository as any).createPrivacyPolicyAcceptance(dbUser.id, latestPP, ip, ua);
    if (input.acceptTermsOfService && latestTOS) await (repository as any).createTermsOfServiceAcceptance(dbUser.id, latestTOS, ip, ua);
    if (input.acceptMarketing && latestMT) await (repository as any).createMarketingTermsAcceptance(dbUser.id, latestMT, ip, ua);

    return reply.send({ id: dbUser.id, keycloakSub: kcSub, email: dbUser.email });
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
