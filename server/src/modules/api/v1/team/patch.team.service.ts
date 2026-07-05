import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveTeamContext } from './team.context.js';
import { toTeamMember, type TeamMember } from './team.member.js';

// Setting 'USER' is the demote/remove action (the person stays a normal
// customer). ADMIN is deliberately not accepted here — it can never be set or
// edited via this API.
const patchBodySchema = z
  .object({
    role: z.enum(['STAFF', 'MANAGER', 'BRAND_MANAGER', 'USER']),
  })
  .strict();

// For a given caller role, the set of roles the caller may both edit (target's
// CURRENT role) and set (target's NEW role). ADMIN is absent from every set, so
// an ADMIN target can never be edited and an ADMIN role can never be assigned.
const ALLOWED_ROLES: Record<string, ReadonlySet<string>> = {
  BRAND_MANAGER: new Set(['USER', 'STAFF', 'MANAGER']),
  ADMIN: new Set(['USER', 'STAFF', 'MANAGER', 'BRAND_MANAGER']),
};

type PatchTeamResponse = { member: TeamMember } | { error: string; message?: string };

export async function patchTeamService(
  request: FastifyRequest<{ Params: { userId: string } }>,
): Promise<ServiceResponse<PatchTeamResponse>> {
  const resolved = await resolveTeamContext(request);
  if (!resolved.ok) return resolved.response;
  const { brandId, callerUserId, callerRole } = resolved.context;

  const parsed = patchBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return { statusCode: 400, body: { error: 'INVALID_BODY' } };
  }
  const newRole = parsed.data.role;

  const { userId: targetUserId } = request.params;
  if (!targetUserId) {
    return { statusCode: 400, body: { error: 'INVALID_USER_ID' } };
  }

  try {
    const repository = (request.server as any).repository as any;

    // 1. Target must have a membership in the caller's brand.
    const targetMembership = await repository.getMembershipByBrand(targetUserId, brandId);
    if (!targetMembership) {
      return { statusCode: 404, body: { error: 'MEMBER_NOT_FOUND' } };
    }

    // 2. A caller cannot edit their own membership.
    if (targetUserId === callerUserId) {
      return { statusCode: 400, body: { error: 'CANNOT_EDIT_SELF', message: 'Non puoi modificare il tuo ruolo' } };
    }

    // 3. Permission matrix.
    const allowed = ALLOWED_ROLES[callerRole];
    const currentRole = String(targetMembership.role);
    if (!allowed || !allowed.has(currentRole) || !allowed.has(newRole)) {
      return { statusCode: 403, body: { error: 'FORBIDDEN' } };
    }

    const updated = await repository.upsertMembership(targetUserId, {
      brandId: targetMembership.brandId ?? brandId,
      businessId: targetMembership.businessId ?? null,
      role: newRole,
    });

    const targetUser = await repository.findUserById(targetUserId);
    const member = toTeamMember({
      businessId: updated?.businessId ?? targetMembership.businessId ?? null,
      role: updated?.role ?? newRole,
      user: {
        id: targetUserId,
        email: targetUser?.email ?? null,
        name: targetUser?.name ?? null,
        surname: targetUser?.surname ?? null,
      },
    });

    return { statusCode: 200, body: { member } };
  } catch (error) {
    request.log.error({ err: error }, 'PATCH_TEAM_FAILED');
    return { statusCode: 500, body: { error: 'PATCH_TEAM_FAILED' } };
  }
}
