import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveTeamContext } from './team.context.js';
import { sortTeamMembers, toTeamMember, type TeamMember } from './team.member.js';

type GetTeamResponse = { members: TeamMember[] } | { error: string; message?: string };

export async function getTeamService(request: FastifyRequest): Promise<ServiceResponse<GetTeamResponse>> {
  const resolved = await resolveTeamContext(request);
  if (!resolved.ok) return resolved.response;

  try {
    const repository = (request.server as any).repository as any;
    const rows = await repository.listBrandTeamMembers(resolved.context.brandId);
    const members = sortTeamMembers((rows as any[]).map((row) => toTeamMember(row)));
    return { statusCode: 200, body: { members } };
  } catch (error) {
    request.log.error({ err: error }, 'GET_TEAM_FAILED');
    return { statusCode: 500, body: { error: 'GET_TEAM_FAILED' } };
  }
}
