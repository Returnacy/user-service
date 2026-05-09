import type { FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type ResetPasswordBody = {
  token: string;
  newPassword: string;
};

type ResetPasswordResponse = { ok: true } | { error: string };

export async function postResetPasswordService(request: FastifyRequest): Promise<ServiceResponse<ResetPasswordResponse>> {
  try {
    const body = (request.body || {}) as Partial<ResetPasswordBody>;
    const token = String(body.token || '').trim();
    const newPassword = String(body.newPassword || '').trim();
    if (!token || !newPassword) {
      return { statusCode: 400, body: { error: 'TOKEN_AND_PASSWORD_REQUIRED' } };
    }
    if (newPassword.length < 8) {
      return { statusCode: 400, body: { error: 'PASSWORD_TOO_SHORT' } };
    }

    const repository = (request.server as any).repository as any;
    const row = await repository.consumePasswordResetToken(token);
    if (!row) return { statusCode: 400, body: { error: 'INVALID_OR_EXPIRED_TOKEN' } };

    const user = await repository.findUserById(row.userId);
    if (!user) return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };

    // Phase 2.6: store the new password as a local bcrypt hash. Keycloak Admin
    // API was previously called here; that dependency is gone.
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await repository.upsertUserByKeycloakSub(user.keycloakSub, {
      passwordHash,
      passwordAlgorithm: 'bcrypt',
      passwordUpdatedAt: new Date(),
    });

    return { statusCode: 200, body: { ok: true } };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'RESET_PASSWORD_FAILED' } };
  }
}
