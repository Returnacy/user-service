import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { renderEmailTemplate } from '@/utils/emailTemplates.js';
import { buildResetLink, buildDomainResetBase, normalizeAbsoluteUrl, resolveDomainFromRequest } from './post.forgotPassword.service.js';

type VerifyEmailBody = {
  redirectUri?: string;
};

type TokenService = { getAccessToken(): Promise<string> };

type VerifyEmailResponse = { ok: true } | { error: string };

export async function postVerifyEmailService(request: FastifyRequest): Promise<ServiceResponse<VerifyEmailResponse>> {
  const auth = (request as any).auth as any;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const repository = (request.server as any).repository as any;
    const user = await repository.findUserByKeycloakSub(auth.sub);
    if (!user?.email) return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };

    // Create token and compose verification link
  const body = (request.body || {}) as VerifyEmailBody;
  const ttlMinutes = Number.parseInt(process.env.EMAIL_VERIFY_TTL_MINUTES || '1440', 10);
  const tokenRow = await repository.createEmailVerificationToken(user.id, Number.isFinite(ttlMinutes) ? ttlMinutes : 1440);
  const domain = await resolveDomainFromRequest(request);
  const redirectBase = normalizeAbsoluteUrl(body.redirectUri ?? null);
    const domainBase = buildDomainResetBase(domain);
    const verifyBase = normalizeAbsoluteUrl(process.env.FRONTEND_VERIFY_EMAIL_URL || null);
    const envBase = normalizeAbsoluteUrl(process.env.FRONTEND_BASE_URL || null, '/auth/verify-email');
    const effectiveBase = redirectBase ?? domainBase ?? verifyBase ?? envBase;
    const url = buildResetLink(effectiveBase, tokenRow.token);

    // Send email via messaging-service (Resend)
    const messagingUrl = process.env.MESSAGING_SERVICE_URL;
    if (!messagingUrl) return { statusCode: 500, body: { error: 'MESSAGING_SERVICE_URL_NOT_CONFIGURED' } };
    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const accessToken = await tokenService.getAccessToken();
    const from = process.env.EMAIL_FROM || 'noreply@returnacy.app';

    const businessName = process.env.BUSINESS_NAME || 'la tua attività';
    const businessEmoji = process.env.BUSINESS_EMOJI || '🍕';
    const userName = `${user.name || ''} ${user.surname || ''}`.trim() || 'Cliente';
    const subject = `Verifica il tuo indirizzo email - ${businessName}`;
    const bodyHtml = await renderEmailTemplate('verifyEmail.html', {
      user_name: userName,
      business_name: businessName,
      business_emoji: businessEmoji,
      verification_link: url,
    });
    const idempotencyKey = `verify:${user.id}:${tokenRow.id}`;
    await axios.post(`${messagingUrl}/api/v1/messages`, {
      campaignId: null,
      recipientId: user.id,
      idempotencyKey,
      channel: 'EMAIL',
      scheduledAt: null,
      payload: {
        subject,
        bodyHtml,
        bodyText: `Per verificare la tua email visita: ${url}`,
        from,
        to: { email: user.email, name: `${user.name || ''} ${user.surname || ''}`.trim() || 'Utente' }
      },
      maxAttempts: 1
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'VERIFY_EMAIL_FAILED' } };
  }
}
