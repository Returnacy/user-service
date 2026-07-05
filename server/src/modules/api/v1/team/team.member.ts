// Shared shape + ordering for team members returned by GET /team and
// PATCH /team/:userId.
export type TeamMember = {
  userId: string;
  email: string | null;
  name: string | null;
  surname: string | null;
  role: string;
  businessId: string | null;
};

// Ordering used for GET /team: most-privileged role first, then by name.
// USER never appears here (those rows are excluded upstream).
const ROLE_RANK: Record<string, number> = {
  ADMIN: 0,
  BRAND_MANAGER: 1,
  MANAGER: 2,
  STAFF: 3,
};

export function toTeamMember(membership: { businessId: string | null; role: string; user: { id: string; email: string | null; name: string | null; surname: string | null } }): TeamMember {
  return {
    userId: membership.user.id,
    email: membership.user.email ?? null,
    name: membership.user.name ?? null,
    surname: membership.user.surname ?? null,
    role: String(membership.role),
    businessId: membership.businessId ?? null,
  };
}

export function sortTeamMembers(members: TeamMember[]): TeamMember[] {
  return [...members].sort((a, b) => {
    const ra = ROLE_RANK[a.role] ?? 99;
    const rb = ROLE_RANK[b.role] ?? 99;
    if (ra !== rb) return ra - rb;
    const na = `${a.name ?? ''} ${a.surname ?? ''}`.trim().toLowerCase();
    const nb = `${b.name ?? ''} ${b.surname ?? ''}`.trim().toLowerCase();
    return na.localeCompare(nb);
  });
}
