import type { FastifyReply, FastifyRequest } from 'fastify';

type ProfileBody = {
  name?: string;
  surname?: string;
  birthday?: string;
  phone?: string;
};

export async function postProfileHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

  try {
    const body = (request.body || {}) as Partial<ProfileBody>;
    const repository = (request.server as any).repository as { upsertUserByKeycloakSub: Function };

    const payload: any = {};
    if (typeof body.name === 'string') payload.name = body.name;
    if (typeof body.surname === 'string') payload.surname = body.surname;
    if (typeof body.birthday === 'string') payload.birthday = body.birthday;
    if (typeof body.phone === 'string') payload.phone = body.phone;

    if (Object.keys(payload).length === 0) {
      return reply.status(400).send({ error: 'NO_FIELDS_TO_UPDATE' });
    }

    const updated = await (repository as any).upsertUserByKeycloakSub(auth.sub, payload);
    return reply.send({ ok: true, user: { id: updated.id, name: updated.name, surname: updated.surname, birthday: updated.birthday, phone: updated.phone } });
  } catch (error: any) {
    request.log.error(error?.response?.data || error);
    return reply.status(400).send({ error: 'PROFILE_UPDATE_FAILED' });
  }
}
