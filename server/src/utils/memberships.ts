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
