import type { FastifyInstance } from 'fastify';

import { getTeamHandler } from './get.team.controller.js';
import { getTeamSearchHandler } from './get.teamSearch.controller.js';
import { patchTeamHandler } from './patch.team.controller.js';

// Mounted at /api/v1/team (see appBuilder). Every handler enforces the
// BRAND_MANAGER/ADMIN guard via resolveTeamContext.
export async function teamRoute(server: FastifyInstance) {
  server.get('/', { handler: getTeamHandler });
  server.get('/search', { handler: getTeamSearchHandler });
  server.patch('/:userId', { handler: patchTeamHandler });
}
