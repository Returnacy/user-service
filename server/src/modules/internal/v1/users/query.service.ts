import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { fetchDomainBusinesses } from '@/utils/domainMapping.js';

type Rule = { database: 'USER' | string; field: string; operator: string; value: any };

type SortField = 'name' | 'stamp' | 'coupon' | 'lastVisit';
type SortDirection = 'asc' | 'desc';
type QueryFilters = {
  minStamps?: number;
  couponsOnly?: boolean;
  lastVisitDays?: number | null;
};

type QueryBody = {
  targetingRules?: Rule[];
  limit?: number;
  page?: number;
  offset?: number;
  search?: string | null;
  sortBy?: SortField;
  sortOrder?: SortDirection;
  filters?: QueryFilters;
  businessId?: string | null;
  brandId?: string | null;
  prize?: { id: string } | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MAX_TAKE = 1000;

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function todayPartsUTC() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { mm, dd };
}

function partsDaysBeforeUTC(days: number) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { yyyy, mm, dd };
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
  if (token === '7_DAYS_BEFORE_SUFFIX_MM_DD') {
    const { mm, dd } = partsDaysBeforeUTC(7);
    return `-${mm}-${dd}`;
  }
  if (token === '30_DAYS_BEFORE_SUFFIX_MM_DD') {
    const { mm, dd } = partsDaysBeforeUTC(30);
    return `-${mm}-${dd}`;
  }
  if (token === '30_DAYS_BEFORE') {
    const { yyyy, mm, dd } = partsDaysBeforeUTC(30);
    return `${yyyy}-${mm}-${dd}`;
  }
  if (token === '40_DAYS_BEFORE') {
    const { yyyy, mm, dd } = partsDaysBeforeUTC(40);
    return `${yyyy}-${mm}-${dd}`;
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
  try {
    if (!isServiceRequest(request)) {
      return { statusCode: 403, body: { error: 'FORBIDDEN' } };
    }

    const repository = (request.server as any).repository as any;
    if (!repository) {
      request.log.error('Repository not available on server instance');
      return { statusCode: 500, body: { error: 'INTERNAL_ERROR' } };
    }

    const body = (request.body ?? {}) as QueryBody;
    const rawLimit = body.limit;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit as number), MAX_LIMIT)) : DEFAULT_LIMIT;
  const rawPage = body.page;
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage as number)) : 1;
  const rawOffset = body.offset;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset as number)) : (page - 1) * limit;
  const maxTakeEnv = Number((process.env.INTERNAL_USERS_QUERY_MAX ?? '').trim() || '0');
  const maxTake = Number.isFinite(maxTakeEnv) && maxTakeEnv > 0 ? Math.max(limit, Math.trunc(maxTakeEnv)) : DEFAULT_MAX_TAKE;
  // When a free-text search is present, widen the candidate window to improve matching coverage
  const desiredTake = Math.max(offset + limit, (typeof body.search === 'string' && body.search.trim().length > 0) ? (limit * 50) : (limit * 10));
  const take = Math.min(desiredTake, maxTake);

  const targetingRules = Array.isArray(body.targetingRules) ? body.targetingRules : [];
  const searchRaw = typeof body.search === 'string' ? body.search.trim() : '';
  const search = searchRaw.length > 0 ? searchRaw : '';
  const sortBy = body.sortBy ?? 'name';
  const sortOrder: SortDirection = body.sortOrder === 'desc' ? 'desc' : 'asc';
  const filters = body.filters ?? {};
  let minStamps = Number.isFinite(filters.minStamps) ? Math.max(0, Math.trunc(filters.minStamps as number)) : null;
  const legacyMinStamp = Number.isFinite((body as any).minStamp)
    ? Math.max(0, Math.trunc((body as any).minStamp as number))
    : null;
  if (minStamps === null && legacyMinStamp !== null) {
    minStamps = legacyMinStamp;
  }
  const couponsOnly = filters.couponsOnly === true;
  const lastVisitDays = Number.isFinite(filters.lastVisitDays)
    ? Math.max(1, Math.trunc(filters.lastVisitDays as number))
    : null;
  const businessId = body.businessId ?? null;
  const brandId = body.brandId ?? null;
  const prize = body.prize ?? null;

  const rules = targetingRules.filter((r) => r.database === 'USER');
  const processedRules = rules.map((r) => ({ ...r, value: resolveDynamicValue(r.field, r.operator, r.value) }));

  let candidates: any[];
  if (businessId) {
    candidates = await (repository.findUsersForTargetingByBusiness?.(businessId, take) ?? repository.findUsersForTargeting(take));
  } else if (brandId) {
    candidates = await (repository.findUsersForTargetingByBrand?.(brandId, take) ?? repository.findUsersForTargeting(take));
  } else {
    candidates = await repository.findUsersForTargeting(take);
  }

  const requiresScope = Boolean(businessId || brandId);

  const enriched = await Promise.all(candidates.map(async (u: any) => {
    let validStamps: number | null = null;
    let totalStamps: number | null = null;
    let tokens: number | null = null;
    let validCoupons: number | null = null;
    let lastVisitedAt: Date | null = null;
    let matchesRequestedScope = !requiresScope;
    if (requiresScope) {
      try {
        const mships = await repository.listMemberships(u.id);
        let membership = null as any;
        if (businessId) membership = mships.find((ms: any) => ms.businessId === businessId);
        if (!membership && brandId) membership = mships.find((ms: any) => ms.brandId === brandId);
        if (membership) {
          matchesRequestedScope = true;
          const stampValue = membership.validStamps as number | null;
          if (typeof stampValue === 'number' && Number.isFinite(stampValue)) {
            validStamps = stampValue;
          } else if (stampValue !== null && stampValue !== undefined) {
            validStamps = Number(stampValue) || 0;
          }
          const totalStampValue = membership.totalStamps as number | null;
          if (typeof totalStampValue === 'number' && Number.isFinite(totalStampValue)) {
            totalStamps = totalStampValue;
          } else if (totalStampValue !== null && totalStampValue !== undefined) {
            const parsedTotal = Number(totalStampValue);
            totalStamps = Number.isFinite(parsedTotal) ? parsedTotal : (validStamps ?? 0);
          }
          tokens = typeof membership.tokens === 'number' ? membership.tokens : (membership.tokens ?? null);
          const couponValue = membership.validCoupons as number | null;
          if (typeof couponValue === 'number' && Number.isFinite(couponValue)) {
            validCoupons = couponValue;
          } else if (couponValue !== null && couponValue !== undefined) {
            validCoupons = Number(couponValue) || 0;
          }
          if (membership.lastVisitedAt) {
            lastVisitedAt = new Date(membership.lastVisitedAt);
          }
        }
      } catch {
        // ignore membership enrichment errors per user
      }
    }
    return { ...u, validStamps, totalStamps, tokens, validCoupons, lastVisitedAt, matchesRequestedScope };
  }));

  const filteredByRules = enriched.filter((u: any) => processedRules.every((r) => matchesOperator(pickUserField(u, r.field), r.operator, r.value)));

  // Apply free-text search across name, surname, email, and phone (OR semantics)
  const filteredBySearch = search
    ? filteredByRules.filter((u: any) => {
        const fullName = `${u.name ?? ''} ${u.surname ?? ''}`.trim().toLowerCase();
        const email = (u.email ?? '').toLowerCase();
        const phone = String(u.phone ?? '');
        const phoneDigits = phone.replace(/\D+/g, '');
        const s = search.toLowerCase();
        const sDigits = search.replace(/\D+/g, '');
        return (
          (fullName && fullName.includes(s)) ||
          (email && email.includes(s)) ||
          (phone && phone.toLowerCase().includes(s)) ||
          (sDigits && phoneDigits && phoneDigits.includes(sDigits))
        );
      })
    : filteredByRules;

  const filtered = filteredBySearch.filter((row: any) => {
    if (requiresScope && !row.matchesRequestedScope) return false;
    if (minStamps !== null && (row.validStamps ?? 0) < minStamps) return false;
    if (couponsOnly && (row.validCoupons ?? 0) <= 0) return false;
    if (lastVisitDays !== null) {
      const cutoff = Date.now() - (lastVisitDays * 24 * 60 * 60 * 1000);
      const last = row.lastVisitedAt instanceof Date
        ? row.lastVisitedAt.getTime()
        : row.lastVisitedAt
          ? new Date(row.lastVisitedAt).getTime()
          : 0;
      if (last < cutoff) return false;
    }
    return true;
  });

  const multiplier = sortOrder === 'desc' ? -1 : 1;
  const sorted = [...filtered].sort((a: any, b: any) => {
    switch (sortBy) {
      case 'stamp': {
        // Order by TOTAL stamps (valid + used) when available; fallback to validStamps
        const av = Number(a.totalStamps ?? a.validStamps ?? 0);
        const bv = Number(b.totalStamps ?? b.validStamps ?? 0);
        return (av - bv) * multiplier;
      }
      case 'coupon': {
        const av = Number(a.validCoupons ?? 0);
        const bv = Number(b.validCoupons ?? 0);
        return (av - bv) * multiplier;
      }
      case 'lastVisit': {
        const av = a.lastVisitedAt ? new Date(a.lastVisitedAt).getTime() : 0;
        const bv = b.lastVisitedAt ? new Date(b.lastVisitedAt).getTime() : 0;
        return (av - bv) * multiplier;
      }
      case 'name':
      default: {
        const an = `${a.name ?? ''} ${a.surname ?? ''}`.trim().toLowerCase();
        const bn = `${b.name ?? ''} ${b.surname ?? ''}`.trim().toLowerCase();
        return an.localeCompare(bn) * multiplier;
      }
    }
  });

  // If a search is present, widen the candidate window slightly to improve page stability under filtering
  const effectiveTake = search ? Math.min(Math.max(take, limit * 20), Math.max(take, limit * 20)) : take;
  const trimmed = sorted.slice(0, effectiveTake);
  const paged = trimmed.slice(offset, offset + limit);

  const users = paged.map((u: any) => ({
    id: u.id != null ? String(u.id) : null,
    email: u.email ?? null,
    phone: u.phone ?? null,
    firstName: u.name ?? null,
    lastName: u.surname ?? null,
    attributes: {
      ...(toJsonSafe(u.preferences ?? {}) as Record<string, unknown>),
      birthday: u.birthday ?? null,
      stamps: u.validStamps ?? null,
      tokens: toFiniteNumberOrNull(u.tokens),
    },
    stats: {
      validStamps: u.validStamps ?? 0,
      totalStamps: u.totalStamps ?? (u.validStamps ?? 0),
      validCoupons: u.validCoupons ?? 0,
      lastVisit: u.lastVisitedAt ? new Date(u.lastVisitedAt).toISOString() : null,
    },
  }));

  if (prize && prize.id) {
    let targetBusinessId: string | null = businessId || null;
    if (!targetBusinessId && brandId) {
      try {
        const businesses = await fetchDomainBusinesses();
        const match = businesses.find((entry) => entry.brandId === brandId && entry.businessId);
        if (match?.businessId) {
          targetBusinessId = match.businessId;
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
          const current = queue.shift()!;
          try {
            const membership = await repository.getMembership(current.id, targetBusinessId!);
            const nextValid = (membership?.validCoupons ?? 0) + 1;
            await repository.setMembershipCounters(current.id, targetBusinessId!, { validCoupons: nextValid, totalCouponsDelta: 1 });
          } catch (error) {
            request.log.warn({ err: error }, 'Failed to increment coupon counter for user');
          }
        }
      };
      for (let i = 0; i < concurrency; i++) workers.push(runWorker());
      await Promise.all(workers);
    }
  }

  return { statusCode: 200, body: { users } };
  } catch (error) {
    request.log.error({ err: error }, 'Error in postUsersQueryService');
    return { statusCode: 500, body: { error: 'INTERNAL_ERROR' } };
  }
}
