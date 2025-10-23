import fp from 'fastify-plugin';

type Membership = {
  brandId: string | null;
  businessId: string | null;
  roles: string[];
};

declare module 'fastify' {
  interface FastifyRequest {
    userMemberships?: Membership[];
  }
}

export default fp(async (fastify) => {
  fastify.decorateRequest('userMemberships', undefined);

  fastify.addHook('preHandler', async (request) => {
    if (!request.auth) return; // requires keycloakAuthPlugin to run first

    const raw = (request.auth as any)?.memberships ?? (request.auth as any)?.membership;
    let memberships: Membership[] = [];

    function coerceToMembershipArray(input: unknown): Membership[] {
      const out: Membership[] = [];
      if (!input) return out;
      const pushIfValid = (m: any) => {
        if (
          m &&
          (typeof m.brandId === 'string' || m.brandId === null || typeof m.brandId === 'undefined') &&
          (typeof m.businessId === 'string' || m.businessId === null || typeof m.businessId === 'undefined')
        ) {
          out.push({
            brandId: m.brandId ?? null,
            businessId: m.businessId ?? null,
            roles: Array.isArray(m.roles) ? m.roles : [],
          });
        }
      };

      const tryParse = (s: string) => {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) parsed.forEach(pushIfValid);
          else pushIfValid(parsed);
        } catch {}
      };

      if (Array.isArray(input)) {
        for (const el of input) {
          if (typeof el === 'string') tryParse(el);
          else if (Array.isArray(el)) el.forEach(pushIfValid);
          else if (typeof el === 'object' && el !== null) pushIfValid(el);
        }
      } else if (typeof input === 'string') {
        tryParse(input);
      } else if (typeof input === 'object') {
        pushIfValid(input);
      }

      return out;
    }

    memberships = coerceToMembershipArray(raw);
    request.userMemberships = memberships;
  });
});
