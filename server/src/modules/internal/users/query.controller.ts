import type { FastifyReply, FastifyRequest } from 'fastify';

type Rule = { database: 'USER' | string; field: string; operator: string; value: any };

function todayPartsUTC() {
  const d = new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return { mm, dd };
}

// Support simple dynamic placeholders in rule values so campaigns can remain static while rules are dynamic.
// Supported tokens (string equality or wrapped with ${...} or {{...}}):
//  - TODAY_MM_DD -> "MM-DD" (e.g., "10-24")
//  - TODAY_SUFFIX_MM_DD -> "-MM-DD" (e.g., "-10-24") to match suffix in YYYY-MM-DD fields using CONTAINS
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
      // Handle dates if possible, fallback to numeric
      const a = Date.parse(fieldValue);
      const b = Date.parse(value);
      if (!isNaN(a) && !isNaN(b)) return a > b;
      return Number(fieldValue) > Number(value);
    }
    case 'LESS_THAN': {
      const a = Date.parse(fieldValue);
      const b = Date.parse(value);
      if (!isNaN(a) && !isNaN(b)) return a < b;
      return Number(fieldValue) < Number(value);
    }
    case 'IN': return Array.isArray(value) && value.includes(fieldValue);
    case 'NOT_IN': return Array.isArray(value) && !value.includes(fieldValue);
    default: return false;
  }
}

function pickUserField(rec: any, field: string): any {
  // Map common fields
  if (field === 'email') return rec.email;
  if (field === 'phone') return rec.phone;
  if (field === 'firstName' || field === 'name') return rec.name;
  if (field === 'lastName' || field === 'surname') return rec.surname;
  if (field === 'birthday') return rec.birthday;
  if (field === 'stamps') return rec.stamps;
  if (field === 'tokens') return rec.tokens;
  // fallback to preferences JSON
  if (rec.preferences && typeof rec.preferences === 'object') return (rec.preferences as any)[field];
  return undefined;
}

export async function postInternalUsersQueryHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  const azp = auth?.azp;
  const aud = auth?.aud;
  const allowedServices = (process.env.KEYCLOAK_SERVICE_AUDIENCE || 'campaign-service,messaging-service,user-service')
    .split(',').map(s => s.trim());
  const audList: string[] = Array.isArray(aud) ? aud : (typeof aud === 'string' ? [aud] : []);
  const isService = (azp && allowedServices.includes(azp)) || audList.some(a => allowedServices.includes(a));
  if (!isService) return reply.status(403).send({ error: 'FORBIDDEN' });

  const { targetingRules, limit, businessId, brandId } = request.body as { targetingRules: Rule[]; limit: number; businessId?: string | null; brandId?: string | null };
  const repository = (request.server as any).repository as any;

  // Only USER database rules are handled here
  const rules = (targetingRules || []).filter(r => r.database === 'USER');
  const processedRules = rules.map(r => ({ ...r, value: resolveDynamicValue(r.field, r.operator, r.value) }));

  // Simple filtering in DB: pull candidates and filter in memory (replace with SQL where mapping later)
  const candidates = await repository.findUsersForTargeting(limit ?? 1000);

  // Enrich candidates with membership-derived fields (stamps, tokens) based on scope
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
      } catch (e) {
        // ignore membership enrichment errors per user
      }
    }
    return { ...u, stamps, tokens };
  }));

  const filtered = enriched.filter((u: any) => processedRules.every(r => matchesOperator(pickUserField(u, r.field), r.operator, r.value)));
  const sliced = filtered.slice(0, limit ?? 100);

  // Project to TargetUser shape
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

  return reply.send({ users });
}
