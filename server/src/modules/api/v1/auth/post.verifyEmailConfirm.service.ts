import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type VerifyConfirmBody = { token: string };

type VerifyConfirmResponse = { ok: true } | { error: string };

export async function postVerifyEmailConfirmService(request: FastifyRequest): Promise<ServiceResponse<VerifyConfirmResponse>> {
  try {
    const body = (request.body || {}) as Partial<VerifyConfirmBody>;
    const token = String(body.token || '').trim();
    if (!token) return { statusCode: 400, body: { error: 'TOKEN_REQUIRED' } };

    const repository = (request.server as any).repository as any;
    const row = await repository.consumeEmailVerificationToken(token);
    if (!row) return { statusCode: 400, body: { error: 'INVALID_OR_EXPIRED_TOKEN' } };

    const user = await repository.findUserById(row.userId);
    if (!user) return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };

    // Phase 2.6: previously this called Keycloak Admin API to set
    // emailVerified=true on the Keycloak user_entity. With customer auth fully
    // self-issued, the email-verified state isn't currently reflected anywhere
    // a token consumer reads (User schema has no isVerified column yet).
    // The token-consume above is the actual side-effect the caller relies on.
    // Adding an isVerified column to User is a separate follow-up.

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'VERIFY_EMAIL_CONFIRM_FAILED' } };
  }
}
