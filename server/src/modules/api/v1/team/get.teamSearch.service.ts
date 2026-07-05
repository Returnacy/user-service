import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveTeamContext } from './team.context.js';

const SEARCH_LIMIT = 10;

const querySchema = z.object({
  q: z.string().min(3),
});

type SearchUser = { userId: string; email: string | null; name: string | null; surname: string | null };

type SearchResponse = { users: SearchUser[] } | { error: string; message?: string };

export async function getTeamSearchService(request: FastifyRequest): Promise<ServiceResponse<SearchResponse>> {
  const resolved = await resolveTeamContext(request);
  if (!resolved.ok) return resolved.response;

  const parsed = querySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    return { statusCode: 400, body: { error: 'INVALID_QUERY' } };
  }
  const q = parsed.data.q.trim();
  if (q.length < 3) {
    return { statusCode: 400, body: { error: 'INVALID_QUERY' } };
  }

  try {
    const repository = (request.server as any).repository as any;
    const rows = await repository.searchBrandUserCandidates(resolved.context.brandId, q, SEARCH_LIMIT);
    const users: SearchUser[] = (rows as any[]).map((row) => ({
      userId: row.user.id,
      email: row.user.email ?? null,
      name: row.user.name ?? null,
      surname: row.user.surname ?? null,
    }));
    return { statusCode: 200, body: { users } };
  } catch (error) {
    request.log.error({ err: error }, 'TEAM_SEARCH_FAILED');
    return { statusCode: 500, body: { error: 'TEAM_SEARCH_FAILED' } };
  }
}
