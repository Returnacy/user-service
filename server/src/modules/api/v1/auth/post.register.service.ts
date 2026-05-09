import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { renderEmailTemplate } from '@/utils/emailTemplates.js';
import { resolveDomain } from '@/utils/domainMapping.js';
import { verifyGoogleIdToken } from '@/utils/googleIdentity.js';
import { ensureDomainMembership } from '@/utils/membershipSync.js';
import { mintTokenPair, type AccessTokenClaims } from '@/utils/selfIssuedJwt.js';
import { registerSchema } from '@user-service/types';

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

type TokenService = { getAccessToken(opts?: { mode?: 'service' | 'admin'; scope?: string }): Promise<string> };

type RegisterResponse = Record<string, unknown>;

function normalizeInput(raw: Record<string, any>) {
  const normalized: Record<string, any> = { ...raw };
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
  return normalized;
}

function buildClaims(user: { keycloakSub: string; email: string; name?: string | null; surname?: string | null }, emailVerified: boolean): AccessTokenClaims {
  const fullName = `${user.name ?? ''} ${user.surname ?? ''}`.trim();
  const claims: AccessTokenClaims = {
    sub: user.keycloakSub,
    email: user.email,
    email_verified: emailVerified,
    preferred_username: user.email,
  };
  if (user.name) claims.given_name = user.name;
  if (user.surname) claims.family_name = user.surname;
  if (fullName) claims.name = fullName;
  return claims;
}

export async function postRegisterService(request: FastifyRequest): Promise<ServiceResponse<RegisterResponse>> {
  try {
    const DEBUG = process.env.DEBUG_MEMBERSHIP === '1';
    const dbg = (data: any, msg: string) => {
      if (DEBUG) request.log.info({ tag: 'membership.debug', ...data }, msg);
    };

    const raw = (request.body ?? {}) as Record<string, any>;
    const normalized = normalizeInput(raw);
    const authType = normalized.authType === 'oauth' ? 'oauth' : 'password';

    const repository = (request.server as any).repository as any;
    const tokenService = (request.server as any).keycloakTokenService as TokenService;

    const passwordInput = authType === 'password' ? registerSchema.parse(normalized) : null;
    const oauthInput = authType === 'oauth' ? oauthRegisterSchema.parse(normalized) : null;

    let googlePayload: Awaited<ReturnType<typeof verifyGoogleIdToken>> | null = null;
    let googleSub: string | null = null;
    if (oauthInput) {
      googlePayload = await verifyGoogleIdToken(oauthInput.idToken);
      googleSub = googlePayload.sub;
      if (!googleSub) {
        return { statusCode: 400, body: { error: 'GOOGLE_SUB_MISSING' } };
      }
      if (googlePayload.email_verified === false) {
        return { statusCode: 400, body: { error: 'GOOGLE_EMAIL_NOT_VERIFIED' } };
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

    // For OAuth, no real password is collected — generate one and store its hash so
    // the account can later authenticate via password-recovery if Google is lost.
    const loginPassword = oauthInput ? crypto.randomBytes(24).toString('hex') : passwordInput!.password;

    const xfh = request.headers['x-forwarded-host'] as string | undefined;
    const host = request.headers['host'] as string | undefined;
    const origin = request.headers['origin'] as string | undefined;
    const referer = request.headers['referer'] as string | undefined;
    let originHost = '';
    try { if (origin) originHost = new URL(origin).host; } catch {}
    let refererHost = '';
    try { if (referer) refererHost = new URL(referer).host; } catch {}
    const [resolvedFromHost, resolvedFromXfh, resolvedFromOrigin, resolvedFromReferer] = await Promise.all([
      host ? resolveDomain(host) : Promise.resolve(null),
      xfh ? resolveDomain(xfh) : Promise.resolve(null),
      originHost ? resolveDomain(originHost) : Promise.resolve(null),
      refererHost ? resolveDomain(refererHost) : Promise.resolve(null),
    ]);
    const domain = resolvedFromHost || resolvedFromXfh || resolvedFromOrigin || resolvedFromReferer;

    dbg({ xfh, host, origin, referer, originHost, refererHost, resolvedFromHost, resolvedFromXfh, resolvedFromOrigin, resolvedFromReferer }, 'Resolved domain candidates');

    let existingUser = googleSub ? await repository.findUserByGoogleSub(googleSub) : null;
    if (!existingUser) {
      existingUser = await repository.findUserByEmail(registerData.email);
    }

    if (existingUser) {
      if (authType !== 'oauth') {
        return {
          statusCode: 409,
          body: {
            error: 'EMAIL_ALREADY_EXISTS',
            message: 'Esiste già un account con questa email. Effettua l\'accesso.',
          }
        };
      }

      // OAuth re-link: connect googleSub to the existing local user, ensure membership for current domain
      if (googleSub && (existingUser as any).googleSub !== googleSub) {
        await repository.upsertUserByKeycloakSub(existingUser.keycloakSub, { googleSub });
        existingUser = await repository.findUserByKeycloakSub(existingUser.keycloakSub);
      }

      let membershipResult = { created: false, synced: false, skipped: true };
      if (domain && (domain.businessId || domain.brandId)) {
        const extraAttrs: Record<string, unknown> | undefined = googleSub ? { googleSub: [googleSub], signupProvider: ['google'] } : undefined;
        membershipResult = await ensureDomainMembership({
          repository,
          tokenService,
          user: { id: existingUser.id, keycloakSub: existingUser.keycloakSub },
          domain,
          logger: request.log,
          role: 'USER',
          ...(extraAttrs ? { extraAttributes: extraAttrs as Record<string, unknown> } : {}),
        });
        if (!membershipResult.created && !membershipResult.skipped) {
          return {
            statusCode: 409,
            body: {
              error: 'USER_ALREADY_REGISTERED_FOR_BRAND',
              message: 'Hai già un account per questo brand. Effettua l\'accesso.',
            }
          };
        }
      }

      const tokens = await mintTokenPair(buildClaims(existingUser, true));
      return {
        statusCode: 200,
        body: {
          ...tokens,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          user: {
            id: existingUser.id,
            keycloakSub: existingUser.keycloakSub,
            email: existingUser.email,
          },
          membershipCreated: membershipResult.created,
        },
      };
    }

    // NEW USER PATH — local-only insert (no Keycloak)
    const localSub = crypto.randomUUID();
    const localPasswordHash = await bcrypt.hash(loginPassword, 10);

    const dbUser = await repository.upsertUserByKeycloakSub(localSub, {
      email: registerData.email,
      name: registerData.name,
      surname: registerData.surname,
      birthday: registerData.birthday,
      gender: registerData.gender ?? null,
      userTermsAcceptance: registerData.acceptTermsOfService,
      userPrivacyPolicyAcceptance: registerData.acceptPrivacyPolicy,
      googleSub: googleSub ?? undefined,
      passwordHash: localPasswordHash,
      passwordAlgorithm: 'bcrypt',
      passwordUpdatedAt: new Date(),
    });

    if (domain) {
      dbg({ domain }, 'Upserting local membership derived from domain');
      await repository.upsertMembership(dbUser.id, { businessId: domain.businessId, brandId: domain.brandId, role: 'USER' });
    } else {
      dbg({}, 'No domain-derived membership available; skipping local membership upsert');
    }

    const ip = (request.headers['x-forwarded-for'] as string) || request.ip;
    const ua = request.headers['user-agent'] as string | undefined;
    const latestPP = await repository.getLatestPrivacyPolicyVersion();
    const latestTOS = await repository.getLatestTermsOfServiceVersion();
    const latestMT = await repository.getLatestMarketingTermsVersion();
    if (registerData.acceptPrivacyPolicy && latestPP) await repository.createPrivacyPolicyAcceptance(dbUser.id, latestPP, ip, ua);
    if (registerData.acceptTermsOfService && latestTOS) await repository.createTermsOfServiceAcceptance(dbUser.id, latestTOS, ip, ua);
    if (registerData.acceptMarketing && latestMT) await repository.createMarketingTermsAcceptance(dbUser.id, latestMT, ip, ua);

    // Send verification email (best-effort — pipeline may be broken; do not block registration)
    try {
      const ttlMinutes = Number.parseInt(process.env.EMAIL_VERIFY_TTL_MINUTES || '1440', 10);
      const tokenRow = await repository.createEmailVerificationToken(dbUser.id, Number.isFinite(ttlMinutes) ? ttlMinutes : 1440);
      const verifyBase = process.env.FRONTEND_VERIFY_EMAIL_URL || process.env.FRONTEND_BASE_URL || '';
      const verificationLink = verifyBase ? `${verifyBase}?token=${encodeURIComponent(tokenRow.token)}` : `token:${tokenRow.token}`;

      const businessName = (process.env.BUSINESS_NAME || (domain?.brandId ? String(domain.brandId) : '') || 'la tua attività');
      const businessEmoji = process.env.BUSINESS_EMOJI || '🍕';
      const userName = `${registerData.name}${registerData.surname ? ' ' + registerData.surname : ''}`.trim() || 'Cliente';

      const subject = `Verifica il tuo indirizzo email - ${businessName}`;
      const bodyHtml = await renderEmailTemplate('verifyEmail.html', {
        user_name: userName,
        business_name: businessName,
        business_emoji: businessEmoji,
        verification_link: verificationLink,
      });
      const bodyText = `Ciao ${userName},\n\nPer verificare la tua email visita: ${verificationLink}\n\nSe non hai richiesto questa registrazione, ignora questa email.\n\n${businessName}`;

      const messagingUrl = process.env.MESSAGING_SERVICE_URL;
      if (!messagingUrl) {
        request.log.warn('MESSAGING_SERVICE_URL not configured; skipping verification email send');
      } else {
        const svcToken = await tokenService.getAccessToken({ scope: 'send' });
        const from = process.env.EMAIL_FROM || 'noreply@returnacy.app';
        const idempotencyKey = `verify:register:${dbUser.id}:${tokenRow.id}`;
        await axios.post(`${messagingUrl}/api/v1/messages`, {
          campaignId: null,
          recipientId: dbUser.id,
          idempotencyKey,
          channel: 'EMAIL',
          scheduledAt: null,
          payload: {
            subject,
            bodyHtml,
            bodyText,
            from,
            to: { email: dbUser.email, name: userName || 'Utente' }
          },
          maxAttempts: 1
        }, { headers: { Authorization: `Bearer ${svcToken}`, 'Content-Type': 'application/json' } });
      }
    } catch (sendErr) {
      request.log.error({ err: sendErr }, 'Failed to send verification email after registration');
    }

    const tokens = await mintTokenPair(buildClaims(dbUser, false));
    return {
      statusCode: 200,
      body: {
        ...tokens,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        user: {
          id: dbUser.id,
          keycloakSub: localSub,
          email: dbUser.email,
        },
      },
    };
  } catch (error: any) {
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'Registration failed');
    if (error?.response?.status === 409) {
      return { statusCode: 409, body: { error: 'EMAIL_ALREADY_EXISTS', detail } };
    }
    return { statusCode: 400, body: { error: 'REGISTRATION_FAILED', detail } };
  }
}
