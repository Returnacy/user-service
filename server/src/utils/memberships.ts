export type Membership = { brandId: string | null; businessId: string | null; roles: string[] };

export function buildMembershipAttribute(memberships: Membership[] = []): string[] {
  // Keycloak stores attributes as array of strings; we store a single JSON array string
  return [JSON.stringify(memberships.map(m => ({
    brandId: m.brandId ?? null,
    businessId: m.businessId ?? null,
    roles: Array.isArray(m.roles) ? m.roles : []
  })))];
}
