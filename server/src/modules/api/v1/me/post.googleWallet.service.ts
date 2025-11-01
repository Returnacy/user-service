import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveDomain } from '@/utils/domainMapping.js';
import { createLoyaltySaveJwt } from '@/utils/googleWallet.js';

const bodySchema = z.object({
  businessId: z.string().min(1, 'businessId is required').optional(),
  qrCode: z.string().min(1).optional(),
});

type GoogleWalletResponse =
  | { error: string; message?: string }
  | { saveUrl: string; jwt: string; objectId: string; classId: string; expiresAt: string | null };

function pickOrigins(request: FastifyRequest): string[] {
  const origins: string[] = [];
  const originHeader = request.headers['origin'];
  if (typeof originHeader === 'string') origins.push(originHeader);

  const referer = request.headers['referer'];
  if (typeof referer === 'string') {
    try {
      const url = new URL(referer);
      origins.push(`${url.protocol}//${url.host}`);
    } catch {
      // ignore invalid referer
    }
  }
  return origins;
}

export async function postGoogleWalletService(request: FastifyRequest): Promise<ServiceResponse<GoogleWalletResponse>> {
  const auth = (request as any).auth;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  const repository = (request.server as any).repository;
  if (!repository) {
    return { statusCode: 500, body: { error: 'SERVER_MISCONFIGURED' } };
  }

  const parsed = bodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return { statusCode: 400, body: { error: 'INVALID_PAYLOAD', message: parsed.error.message } };
  }

  const payload = parsed.data;
  const user = await repository.findUserByKeycloakSub(auth.sub);
  if (!user) {
    return { statusCode: 404, body: { error: 'USER_NOT_FOUND' } };
  }

  const host = (request.headers['x-forwarded-host'] as string) || (request.headers['host'] as string);
  const domain = resolveDomain(host);

  let businessId: string | null = payload.businessId ?? domain?.businessId ?? null;

  let membership = null as any;
  if (businessId) {
    membership = await repository.getMembership(user.id, businessId);
  }

  if (!membership) {
    const memberships = await repository.listMemberships(user.id);
    if (!businessId && memberships.length === 1) {
      businessId = memberships[0].businessId;
      membership = memberships[0];
    } else if (!businessId && memberships.length > 1) {
      const elevated = memberships.find((m: any) => String(m.role).toUpperCase() !== 'USER');
      if (elevated) {
        businessId = elevated.businessId;
        membership = elevated;
      }
    }
  }

  if (!businessId || !membership) {
    return {
      statusCode: 404,
      body: {
        error: 'MEMBERSHIP_NOT_FOUND',
        message: 'Unable to find a membership for the requested businessId',
      },
    };
  }

  const qr = payload.qrCode || user.id;
  const accountName = [user.name, user.surname].filter(Boolean).join(' ').trim() || user.email || `User ${user.id}`;
  const validStamps = typeof membership.validStamps === 'number' ? membership.validStamps : 0;

  try {
    const pass = await createLoyaltySaveJwt({
      userId: user.id,
      accountName,
      accountEmail: user.email || undefined,
      businessId,
      qrValue: qr,
      validStamps,
      origins: pickOrigins(request),
    });

    return {
      statusCode: 200,
      body: {
        saveUrl: pass.saveUrl,
        jwt: pass.jwt,
        objectId: pass.objectId,
        classId: pass.classId,
        expiresAt: pass.expiresAt,
      },
    };
  } catch (error: any) {
    request.server.log.error(error, 'Failed to create Google Wallet pass');
    return {
      statusCode: 500,
      body: { error: 'GOOGLE_WALLET_ERROR', message: error?.message ?? 'Failed to generate pass' },
    };
  }
}
