import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { resolveDomain, resolveBusinessServiceUrl } from '../../utils/domainMapping.js';

export async function getUserByIdHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

  const { userId } = request.params as { userId: string };
  if (!userId) return reply.status(400).send({ error: 'INVALID_USER_ID' });

  const repository = (request.server as any).repository as any;
  const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };

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

  const host = (request.headers['x-forwarded-host'] as string) || (request.headers['host'] as string);
  const domain = resolveDomain(host);
  // 2) Fallback to domain mapping from Host header
  if (!businessId) {
    businessId = domain?.businessId ?? null;
  }

  const forwardedProto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
  const businessServiceBase = resolveBusinessServiceUrl({
    businessId,
    host,
    scheme: forwardedProto || request.protocol,
  });

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

  const usedCoupons = (() => {
    const total = (inScopeMembership as any)?.totalCoupons;
    const asNumber = total == null ? 0 : Number(total);
    if (!Number.isFinite(asNumber)) return 0;
    return Math.max(0, asNumber - validCoupons);
  })();

  let couponsList: any[] = [];
  let nextPrize: { name: string | null; stampsNeededForNextPrize: number; stampsNextPrize: number; stampsLastPrize: number } | null = null;
  if (businessId && businessServiceBase) {
    const base = businessServiceBase.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    try {
      const svcToken = await tokenService.getAccessToken();
      if (svcToken) headers.Authorization = `Bearer ${svcToken}`;
    } catch {}

    try {
      const res = await axios.get(`${base}/api/v1/coupons`, {
        params: { userId: user.id, businessId },
        headers,
      });
      const payload = (res.data && res.data.coupons != null) ? res.data.coupons : res.data;
      const coupons = Array.isArray(payload) ? payload : [];
      const now = Date.now();
      couponsList = coupons.filter((c: any) => !c?.isRedeemed && (!c?.expiredAt || new Date(c.expiredAt).getTime() > now));
    } catch {
      couponsList = [];
    }

    try {
      const res = await axios.post(`${base}/api/v1/prizes/progression`, {
        businessId,
        stamps: Math.max(0, Number(validStamps) || 0),
      }, { headers });
      const data = (res.data && res.data.data != null) ? res.data.data : res.data;
      if (data && typeof data === 'object') {
        const stampsLastPrize = Number((data as any).stampsLastPrize ?? 0) || 0;
        const stampsNextPrize = Number((data as any).stampsNextPrize ?? 0) || 0;
        const needed = Number((data as any).stampsNeededForNextPrize);
        const fallbackNeeded = Math.max(0, stampsNextPrize - Math.max(0, Number(validStamps) || 0));
        nextPrize = {
          name: (data as any).nextPrizeName ?? null,
          stampsLastPrize,
          stampsNextPrize,
          stampsNeededForNextPrize: Number.isFinite(needed) ? Math.max(0, needed) : fallbackNeeded,
        };
      }
    } catch {
      nextPrize = null;
    }
  }

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
    coupons: {
      usedCoupons,
      validCoupons,
      coupons: couponsList.map((c: any) => ({
        id: c.id,
        code: c.code,
        isRedeemed: !!c.isRedeemed,
        redeemedAt: c.redeemedAt ?? null,
        prize: c.prize ? { name: c.prize.name, pointsRequired: c.prize.pointsRequired } : undefined,
        createdAt: c.createdAt,
      })),
    },
    nextPrize,
    // keep consistent flags with /me response
    userAgreement: {
      privacyPolicy: !!user.userPrivacyPolicyAcceptance,
      termsOfService: !!user.userTermsAcceptance,
      marketingPolicy: false,
    },
  });
}
