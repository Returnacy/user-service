import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { renderEmailTemplate } from '@/utils/emailTemplates.js';
import { resolveDomain, type DomainResolution } from '@/utils/domainMapping.js';
import { resolveBrandName } from '@/utils/emailLinks.js';
import { sendMessagingEmail } from '@/utils/messagingClient.js';

type ForgotPasswordBody = {
  email: string;
  redirectUri?: string;
};

type TokenService = { getAccessToken(opts?: { mode?: 'service' | 'admin'; scope?: string }): Promise<string> };

type ForgotPasswordResponse = { ok: true } | { error: string };

export function normalizeAbsoluteUrl(value?: string | null, pathOverride?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, `https://${trimmed}`];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (pathOverride) {
        url.pathname = pathOverride;
        url.search = '';
        url.hash = '';
      }
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export function buildDomainResetBase(domain?: DomainResolution | null): string | null {
  if (!domain) return null;
  const source = domain.url || domain.host;
  if (!source) return null;
  return normalizeAbsoluteUrl(source, '/auth/reset-password');
}

export function buildResetLink(base: string | null, token: string): string {
  if (!base) return `token:${token}`;
  try {
    const url = new URL(base);
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return `token:${token}`;
  }
}

export async function resolveDomainFromRequest(request: FastifyRequest): Promise<DomainResolution | null> {
  const xfh = request.headers['x-forwarded-host'] as string | undefined;
  const host = request.headers['host'] as string | undefined;
  const origin = request.headers['origin'] as string | undefined;
  const referer = request.headers['referer'] as string | undefined;

  const hostCandidates: Array<string | null> = [host ?? null, xfh ?? null];
  const parseHost = (input?: string): string | null => {
    if (!input) return null;
    try {
      return new URL(input).host || null;
    } catch {
      return input;
    }
  };
  hostCandidates.push(parseHost(origin));
  hostCandidates.push(parseHost(referer));

  for (const candidate of hostCandidates) {
    if (!candidate) continue;
    try {
      const resolved = await resolveDomain(candidate);
      if (resolved) return resolved;
    } catch {
      // continue
    }
  }
  return null;
}

export async function postForgotPasswordService(request: FastifyRequest): Promise<ServiceResponse<ForgotPasswordResponse>> {
  try {
    const body = (request.body || {}) as Partial<ForgotPasswordBody>;
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) {
      return { statusCode: 400, body: { error: 'EMAIL_REQUIRED' } };
    }

    const repository = (request.server as any).repository as any;
    const user = await repository.findUserByEmail(email);
    if (!user) {
      // Same answer as a real send, so the endpoint cannot be used to probe
      // which addresses have an account.
      request.log.info('forgot-password requested for an unknown email; answering ok without sending');
      return { statusCode: 200, body: { ok: true } };
    }

  // Create reset token and send via messaging-service
  const ttlMinutes = Number.parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '60', 10);
  const tokenRow = await repository.createPasswordResetToken(user.id, Number.isFinite(ttlMinutes) ? ttlMinutes : 60);

  const domain = await resolveDomainFromRequest(request);
  const redirectBase = normalizeAbsoluteUrl(body.redirectUri ?? null);
  const domainBase = buildDomainResetBase(domain);
  const envResetBase = normalizeAbsoluteUrl(process.env.FRONTEND_RESET_PASSWORD_URL || null);
  const envBase = normalizeAbsoluteUrl(process.env.FRONTEND_BASE_URL || null, '/auth/reset-password');
  const effectiveResetBase = redirectBase ?? domainBase ?? envResetBase ?? envBase;
  const url = buildResetLink(effectiveResetBase, tokenRow.token);

    const messagingUrl = process.env.MESSAGING_SERVICE_URL;
    if (!messagingUrl) return { statusCode: 500, body: { error: 'MESSAGING_SERVICE_URL_NOT_CONFIGURED' } };
    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const accessToken = await tokenService.getAccessToken({ scope: 'send' });
    const from = process.env.EMAIL_FROM || 'noreply@returnacy.app';
    const businessName = resolveBrandName(domain);
    const businessEmoji = process.env.BUSINESS_EMOJI || '🍕';
    const userName = `${user.name || ''} ${user.surname || ''}`.trim() || 'Cliente';
    const subject = `Reimposta la tua password - ${businessName}`;
    const bodyHtml = await renderEmailTemplate('passwordReset.html', {
      user_name: userName,
      business_name: businessName,
      business_emoji: businessEmoji,
      reset_link: url,
      ttl_minutes: ttlMinutes,
    });
    const idempotencyKey = `reset:${user.id}:${tokenRow.id}`;
    await sendMessagingEmail(messagingUrl, accessToken, {
      recipientId: user.id,
      idempotencyKey,
      payload: {
        subject,
        bodyHtml,
        bodyText: `Per reimpostare la password visita: ${url}`,
        from,
        to: { email: user.email, name: `${user.name || ''} ${user.surname || ''}`.trim() || 'Utente' }
      },
    }, request.log);

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'FORGOT_PASSWORD_FAILED' } };
  }
}
