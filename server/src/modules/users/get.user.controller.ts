import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveDomain } from '../../utils/domainMapping.js';

export async function getUserByIdHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

  const { userId } = request.params as { userId: string };
  if (!userId) return reply.status(400).send({ error: 'INVALID_USER_ID' });

  const repository = (request.server as any).repository as any;

  // Determine tenant scope (businessId) without trusting client-provided params
  let businessId: string | null = null;

  // 1) Try to extract from token memberships claim
  try {
    const rawMemberships = Array.isArray((auth as any).memberships) ? (auth as any).memberships : [];
    const parsed: Array<{ businessId?: string|null; brandId?: string|null; roles?: string[] }> = [];
    for (const item of rawMemberships) {
      if (typeof item === 'string') {
        try {
          const val = JSON.parse(item);
          if (Array.isArray(val)) parsed.push(...val);
          else parsed.push(val);
        } catch {}
      } else if (item && typeof item === 'object') {
        parsed.push(item as any);
      }
    }
    // Prefer first membership for scope if multiple
    businessId = parsed.find(m => m?.businessId)?.businessId ?? null;
  } catch {}

  // 2) Fallback to domain mapping from Host header
  if (!businessId) {
    const host = request.headers['x-forwarded-host'] as string || request.headers['host'] as string;
    const domain = resolveDomain(host);
    businessId = domain?.businessId ?? null;
  }

  // Fetch the user and memberships
  const user = await repository.findUserById(String(userId));
  if (!user) return reply.status(404).send({ error: 'NOT_FOUND' });

  const memberships = await repository.listMemberships(user.id);
  const inScopeMembership = businessId
    ? memberships.find((m: any) => m.businessId === businessId)
    : null;

  // Prefer normalized counters from membership (validStamps/validCoupons)
  const validStamps = (() => {
    const s = (inScopeMembership as any)?.validStamps ?? (inScopeMembership as any)?.stamps;
    if (typeof s === 'number') return s;
    if (s == null) return 0;
    const n = Number(s);
    return isNaN(n) ? 0 : n;
  })();

  const validCoupons = (() => {
    const c = (inScopeMembership as any)?.validCoupons;
    if (typeof c === 'number') return c;
    if (c == null) return 0;
    const n = Number(c);
    return isNaN(n) ? 0 : n;
  })();

  return reply.send({
    id: user.id,
    email: user.email,
    name: user.name,
    surname: user.surname,
    phone: user.phone,
    memberships: memberships.map((m: any) => ({ businessId: m.businessId, brandId: m.brandId, role: m.role })),
    scope: { businessId },
    role: inScopeMembership?.role ?? 'USER',
  stamps: { validStamps },
  coupons: { usedCoupons: 0, validCoupons },
    nextPrize: { name: 'Prossimo premio', stampsNeededForNextPrize: 15, stampsNextPrize: 15, stampsLastPrize: 0 },
    // keep consistent flags with /me response
    userAgreement: {
      privacyPolicy: !!user.userPrivacyPolicyAcceptance,
      termsOfService: !!user.userTermsAcceptance,
      marketingPolicy: false,
    },
  });
}
