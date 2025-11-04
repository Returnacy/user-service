import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type ForgotPasswordBody = {
  email: string;
  redirectUri?: string;
};

type TokenService = { getAccessToken(): Promise<string> };

type ForgotPasswordResponse = { ok: true } | { error: string };

export async function postForgotPasswordService(request: FastifyRequest): Promise<ServiceResponse<ForgotPasswordResponse>> {
  try {
    const body = (request.body || {}) as Partial<ForgotPasswordBody>;
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) {
      return { statusCode: 400, body: { error: 'EMAIL_REQUIRED' } };
    }

    const repository = (request.server as any).repository as any;
    const user = await repository.findUserByEmail(email);
    if (!user) return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };

    // Create reset token and send via messaging-service
    const ttlMinutes = Number.parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '60', 10);
    const tokenRow = await repository.createPasswordResetToken(user.id, Number.isFinite(ttlMinutes) ? ttlMinutes : 60);
    const resetBase = process.env.FRONTEND_RESET_PASSWORD_URL || process.env.FRONTEND_BASE_URL || '';
    const url = resetBase ? `${resetBase}?token=${encodeURIComponent(tokenRow.token)}` : `token:${tokenRow.token}`;

    const messagingUrl = process.env.MESSAGING_SERVICE_URL;
    if (!messagingUrl) return { statusCode: 500, body: { error: 'MESSAGING_SERVICE_URL_NOT_CONFIGURED' } };
    const tokenService = (request.server as any).keycloakTokenService as TokenService;
    const accessToken = await tokenService.getAccessToken();
    const from = process.env.EMAIL_FROM || 'noreply@returnacy.app';
    const subject = 'Reimposta la tua password';
    const bodyHtml = `<p>Ciao ${user.name || ''},</p><p>Per reimpostare la password clicca il seguente link:</p><p><a href="${url}">Reimposta password</a></p><p>Questo link scade in ${ttlMinutes} minuti.</p>`;
    const idempotencyKey = `reset:${user.id}:${tokenRow.id}`;
    await axios.post(`${messagingUrl}/api/v1/messages`, {
      campaignId: null,
      recipientId: user.id,
      idempotencyKey,
      channel: 'EMAIL',
      scheduledAt: null,
      payload: {
        subject,
        bodyHtml,
        bodyText: 'Reimposta la tua password',
        from,
        to: { email: user.email, name: `${user.name || ''} ${user.surname || ''}`.trim() || 'Utente' }
      },
      maxAttempts: 1
    }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'FORGOT_PASSWORD_FAILED' } };
  }
}
