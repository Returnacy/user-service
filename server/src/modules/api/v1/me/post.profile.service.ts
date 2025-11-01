import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type ProfileBody = {
  name?: string;
  surname?: string;
  birthday?: string;
  phone?: string;
};

type ProfileResponse = { ok: true; user: Record<string, unknown> } | { error: string };

export async function postProfileService(request: FastifyRequest): Promise<ServiceResponse<ProfileResponse>> {
  const auth = (request as any).auth as any;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const body = (request.body || {}) as Partial<ProfileBody>;
    const repository = (request.server as any).repository as any;

    const payload: Record<string, unknown> = {};
    if (typeof body.name === 'string') payload.name = body.name;
    if (typeof body.surname === 'string') payload.surname = body.surname;
    if (typeof body.birthday === 'string') payload.birthday = body.birthday;
    if (typeof body.phone === 'string') payload.phone = body.phone;

    if (Object.keys(payload).length === 0) {
      return { statusCode: 400, body: { error: 'NO_FIELDS_TO_UPDATE' } };
    }

    const updated = await repository.upsertUserByKeycloakSub(auth.sub, payload);
    return {
      statusCode: 200,
      body: {
        ok: true,
        user: {
          id: updated.id,
          name: updated.name,
          surname: updated.surname,
          birthday: updated.birthday,
          phone: updated.phone,
        },
      },
    };
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return { statusCode: 400, body: { error: 'PROFILE_UPDATE_FAILED' } };
  }
}
