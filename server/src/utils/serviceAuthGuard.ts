import type { FastifyReply, FastifyRequest } from 'fastify';

export function requireAdminRole() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as any).auth as any;
    const memberships = (request as any).userMemberships as Array<{ roles: string[] }> | undefined;
    const azp = auth?.azp;
    const aud = auth?.aud;
    const allowedServices = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service')
      .split(',').map(s => s.trim());

    const audList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
    const isService = (azp && allowedServices.includes(azp)) || audList.some(a => allowedServices.includes(a));

    const isAdmin = Array.isArray(memberships) && memberships.some(m => m.roles?.includes('admin'));
    if (!isService && !isAdmin) {
      return reply.status(403).send({ error: 'FORBIDDEN' });
    }
  };
}
