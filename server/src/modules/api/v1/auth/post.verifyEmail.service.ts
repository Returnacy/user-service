import type { FastifyRequest } from 'fastify';
import axios from 'axios';
import crypto from 'node:crypto';

import type { ServiceResponse } from '@/types/serviceResponse.js';

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
    const ttlMinutes = Number.parseInt(process.env.EMAIL_VERIFY_TTL_MINUTES || '1440', 10);
    const tokenRow = await repository.createEmailVerificationToken(user.id, Number.isFinite(ttlMinutes) ? ttlMinutes : 1440);
    const verifyBase = process.env.FRONTEND_VERIFY_EMAIL_URL || process.env.FRONTEND_BASE_URL || '';
    if (!verifyBase) {
      request.log.warn('FRONTEND_VERIFY_EMAIL_URL not set; sending link with token only');
    }
    const url = verifyBase ? `${verifyBase}?token=${encodeURIComponent(tokenRow.token)}` : `token:${tokenRow.token}`;

    // Send email via messaging-service (Resend)
    const messagingUrl = process.env.MESSAGING_SERVICE_URL;
    if (!messagingUrl) return { statusCode: 500, body: { error: 'MESSAGING_SERVICE_URL_NOT_CONFIGURED' } };
    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const accessToken = await tokenService.getAccessToken();
    const from = process.env.EMAIL_FROM || 'noreply@returnacy.app';

    const subject = 'Verifica la tua email';
    const bodyHtml = `<p>Ciao ${user.name || ''},</p><p>Per verificare la tua email clicca il seguente link:</p><p><a href="${url}">Verifica email</a></p><p>Se non hai richiesto tu questa azione, ignora questa email.</p>`;
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
        bodyText: 'Verifica la tua email',
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
