export type Membership = { brandId: string | null; businessId: string | null; roles: string[] };

export type TokenMembership = {
  brandId?: string | null;
  businessId?: string | null;
  roles?: string[];
  role?: string;
};

export function buildMembershipAttribute(memberships: Membership[] = []): string[] {
  // Keycloak stores attributes as array of strings; we store a single JSON array string
  return [JSON.stringify(memberships.map(m => ({
    brandId: m.brandId ?? null,
    businessId: m.businessId ?? null,
    roles: Array.isArray(m.roles) ? m.roles : []
  })))];
}

export function parseTokenMemberships(rawMemberships: unknown): TokenMembership[] {
  const source = Array.isArray(rawMemberships) ? rawMemberships : [];
  const normalized: TokenMembership[] = [];
  for (const item of source) {
    if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item);
        if (Array.isArray(parsed)) {
          normalized.push(...parsed);
        } else if (parsed && typeof parsed === 'object') {
          normalized.push(parsed as TokenMembership);
        }
      } catch {
        // ignore unparsable entries but continue processing others
      }
      continue;
    }
    if (item && typeof item === 'object') {
      normalized.push(item as TokenMembership);
    }
  }
  return normalized;
}

export function normalizeMemberships(rawMemberships: unknown): Membership[] {
  const parsed = parseTokenMemberships(rawMemberships);
  return parsed.map((m) => {
    const brandId = typeof m.brandId === 'string' && m.brandId.trim().length > 0 ? m.brandId : null;
    const businessId = typeof m.businessId === 'string' && m.businessId.trim().length > 0 ? m.businessId : null;
    const roles = Array.isArray(m.roles) ? m.roles.map((role) => String(role))
      : (typeof m.role === 'string' && m.role.trim().length > 0 ? [m.role.trim()] : []);
    return {
      brandId,
      businessId,
      roles,
    } satisfies Membership;
  });
}

export function membershipMatches(target: { brandId?: string | null; businessId?: string | null }, entry: Membership): boolean {
  const targetBusiness = target.businessId ?? null;
  const targetBrand = target.brandId ?? null;
  if (targetBusiness && entry.businessId) return entry.businessId === targetBusiness;
  if (targetBrand && entry.brandId) return entry.brandId === targetBrand;
  return false;
}

export function ensureMembershipEntry(
  existing: Membership[],
  candidate: { brandId?: string | null; businessId?: string | null; roles?: string[] },
  defaultRole = 'user'
): { updated: boolean; memberships: Membership[] } {
  const brandId = candidate.brandId ?? null;
  const businessId = candidate.businessId ?? null;
  if (!brandId && !businessId) return { updated: false, memberships: existing };

  const alreadyPresent = existing.some((entry) => membershipMatches({ brandId, businessId }, entry));
  if (alreadyPresent) return { updated: false, memberships: existing };

  const roles = candidate.roles && candidate.roles.length > 0
    ? candidate.roles.map((role) => String(role))
    : [defaultRole];

  const next: Membership = { brandId, businessId, roles };
  return { updated: true, memberships: [...existing, next] };
}
