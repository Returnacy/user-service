import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { loadDomainMapping } from '@/utils/domainMapping.js';

type Rule = { database: 'USER' | string; field: string; operator: string; value: any };

type QueryBody = {
  targetingRules: Rule[];
  limit: number;
  businessId?: string | null;
  brandId?: string | null;
  prize?: { id: string } | null;
};

function todayPartsUTC() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { mm, dd };
}

function resolveDynamicValue(field: string, operator: string, value: any): any {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
    const unwrap = (s: string) => s.replace(/^\$\{/, '').replace(/^\{\{/, '').replace(/\}\}$/, '').replace(/\}$/, '');
  const token = unwrap(raw);
  if (token === 'TODAY_MM_DD') {
    const { mm, dd } = todayPartsUTC();
    return `${mm}-${dd}`;
  }
  if (token === 'TODAY_SUFFIX_MM_DD') {
    const { mm, dd } = todayPartsUTC();
    return `-${mm}-${dd}`;
  }
  return value;
}

function matchesOperator(fieldValue: any, operator: string, value: any): boolean {
  switch (operator) {
    case 'EQUALS': return fieldValue === value;
    case 'NOT_EQUALS': return fieldValue !== value;
    case 'CONTAINS': return typeof fieldValue === 'string' && String(fieldValue).includes(String(value));
    case 'NOT_CONTAINS': return typeof fieldValue === 'string' && !String(fieldValue).includes(String(value));
    case 'GREATER_THAN': {
      const a = Date.parse(fieldValue);
      const b = Date.parse(value);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return a > b;
      return Number(fieldValue) > Number(value);
    }
    case 'LESS_THAN': {
      const a = Date.parse(fieldValue);
      const b = Date.parse(value);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return a < b;
      return Number(fieldValue) < Number(value);
    }
    case 'IN': return Array.isArray(value) && value.includes(fieldValue);
    case 'NOT_IN': return Array.isArray(value) && !value.includes(fieldValue);
    default: return false;
  }
}

function pickUserField(rec: any, field: string): any {
  if (field === 'email') return rec.email;
  if (field === 'phone') return rec.phone;
  if (field === 'firstName' || field === 'name') return rec.name;
  if (field === 'lastName' || field === 'surname') return rec.surname;
  if (field === 'birthday') return rec.birthday;
  if (field === 'stamps') return rec.stamps;
  if (field === 'tokens') return rec.tokens;
  if (rec.preferences && typeof rec.preferences === 'object') return (rec.preferences as any)[field];
  return undefined;
}

function isServiceRequest(request: FastifyRequest): boolean {
  const auth = (request as any).auth as any;
  const azp = auth?.azp;
  const aud = auth?.aud;
  const allowedServices = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service')
    .split(',').map((s) => s.trim());
  const audList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
  return (azp && allowedServices.includes(azp)) || audList.some((a) => allowedServices.includes(a));
}

export async function postUsersQueryService(request: FastifyRequest): Promise<ServiceResponse<{ users: any[] } | { error: string }>> {
  if (!isServiceRequest(request)) {
    return { statusCode: 403, body: { error: 'FORBIDDEN' } };
  }

  const { targetingRules, limit, businessId, brandId, prize } = (request.body ?? {}) as QueryBody;
  const repository = (request.server as any).repository as any;

  const rules = (targetingRules || []).filter((r) => r.database === 'USER');
  const processedRules = rules.map((r) => ({ ...r, value: resolveDynamicValue(r.field, r.operator, r.value) }));

  let candidates: any[];
  const take = limit ?? 1000;
  if (businessId) {
    candidates = await (repository.findUsersForTargetingByBusiness?.(businessId, take) ?? repository.findUsersForTargeting(take));
  } else if (brandId) {
    candidates = await (repository.findUsersForTargetingByBrand?.(brandId, take) ?? repository.findUsersForTargeting(take));
  } else {
    candidates = await repository.findUsersForTargeting(take);
  }

  const enriched = await Promise.all(candidates.map(async (u: any) => {
    let stamps: number | null = null;
    let tokens: number | null = null;
    if (businessId || brandId) {
      try {
        const mships = await repository.listMemberships(u.id);
        let m = null as any;
        if (businessId) m = mships.find((ms: any) => ms.businessId === businessId);
        if (!m && brandId) m = mships.find((ms: any) => ms.brandId === brandId);
        if (m) {
          stamps = typeof m.stamps === 'number' ? m.stamps : (m.stamps ?? null);
          tokens = typeof m.tokens === 'number' ? m.tokens : (m.tokens ?? null);
        }
      } catch {
        // ignore membership enrichment errors per user
      }
    }
    return { ...u, stamps, tokens };
  }));

  const filtered = enriched.filter((u: any) => processedRules.every((r) => matchesOperator(pickUserField(u, r.field), r.operator, r.value)));
  const sliced = filtered.slice(0, limit ?? 100);

  const users = sliced.map((u: any) => ({
    id: u.id,
    email: u.email ?? null,
    phone: u.phone ?? null,
    firstName: u.name ?? null,
    lastName: u.surname ?? null,
    attributes: {
      ...(u.preferences ?? {}),
      birthday: u.birthday ?? null,
      stamps: u.stamps ?? null,
      tokens: u.tokens ?? null,
    },
  }));

  if (prize && prize.id) {
    let targetBusinessId: string | null = businessId || null;
    if (!targetBusinessId && brandId) {
      try {
        const map = loadDomainMapping();
        for (const v of Object.values(map)) {
          const entry = v as any;
          if (entry && entry.brandId === brandId && entry.businessId) {
            targetBusinessId = entry.businessId;
            break;
          }
        }
      } catch {
        // ignore mapping resolution errors
      }
    }

    if (targetBusinessId) {
      const concurrency = 12;
      const queue = [...users];
      const workers: Promise<void>[] = [];
      const runWorker = async () => {
        while (queue.length > 0) {
          const u = queue.shift()!;
          try {
            const m = await repository.getMembership(u.id, targetBusinessId!);
            const nextValid = (m?.validCoupons ?? 0) + 1;
            await repository.setMembershipCounters(u.id, targetBusinessId!, { validCoupons: nextValid, totalCouponsDelta: 1 });
          } catch (e) {
            request.log.warn({ err: e }, 'Failed to increment coupon counter for user');
          }
        }
      };
      for (let i = 0; i < concurrency; i++) workers.push(runWorker());
      await Promise.all(workers);
    }
  }

  return { statusCode: 200, body: { users } };
}
