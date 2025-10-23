import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';

export async function patchMembershipsHandler(request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) {
  const { userId } = request.params;
  const body = request.body as any;
  const membershipsInput: Array<{ brandId: string | null; businessId: string; roles: string[] }> = body.memberships || [];

  const repository = (request.server as any).repository as any;
  const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };

  // Ensure each membership exists/updated
  for (const m of membershipsInput) {
    await repository.upsertMembership(userId, { businessId: m.businessId, brandId: m.brandId, role: 'USER' });
  }

  // Update Keycloak attribute
  const attribute = [JSON.stringify(membershipsInput)];
  const adminToken = await tokenService.getAccessToken();
  const baseUrl = process.env.KEYCLOAK_BASE_URL!;
  const realm = process.env.KEYCLOAK_REALM!;

  // Resolve user's keycloak sub from db
  const user = await repository.findUserById(userId);
  if (!user) return reply.status(404).send({ error: 'USER_NOT_FOUND' });

  await axios.put(
    `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}`,
    { attributes: { memberships: attribute } },
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );

  return reply.send({ ok: true });
}
