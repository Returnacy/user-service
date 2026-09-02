/**
 * Promoting a brand's first ADMIN.
 *
 * The provisioning order is: the owner registers on the SPA himself, and only
 * afterwards is he promoted. So this runs against a `User` row that already
 * exists and already holds the real name/surname/birthday the owner typed in.
 * Passing the ADMIN_* defaults through `upsertUserByKeycloakSub` overwrote that
 * row with `Owner` / `` / `1970-01-01` — a client's own details, corrupted by
 * the act of making him an admin.
 *
 * So: the `User` row is written only when this seed has to create it. On an
 * account that already exists nothing about the person is touched — not the
 * name, not the birthday, not the privacy/terms acceptances — and the only
 * write is the ADMIN membership on the given brand/business.
 *
 * Idempotent either way: running it twice leaves the same single membership.
 */

export type SeedBrandAdminRepo = {
  findUserByKeycloakSub(sub: string): Promise<{ id: string; email: string } | null>;
  upsertUserByKeycloakSub(sub: string, data: Record<string, unknown>): Promise<{ id: string; email: string }>;
  getMembership(userId: string, businessId: string): Promise<{ id: string } | null>;
  getMembershipByBrand(userId: string, brandId: string): Promise<{ id: string } | null>;
  upsertMembership(
    userId: string,
    membership: { businessId?: string | null; brandId?: string | null; role?: string },
  ): Promise<{ id: string }>;
};

export type SeedBrandAdminInput = {
  brandId: string;
  businessId: string | null;
  email: string;
  sub: string;
  /** Only used when the user does not exist yet. */
  name?: string | undefined;
  surname?: string | undefined;
  birthday?: string | undefined;
};

export type SeedBrandAdminResult = {
  userId: string;
  user: 'created' | 'kept';
  membership: 'created' | 'updated';
  /** Set when the existing account's email differs from ADMIN_EMAIL — a strong
   * hint that ADMIN_SUB points at the wrong person. */
  emailMismatch: string | null;
};

export async function seedBrandAdmin(
  repo: SeedBrandAdminRepo,
  input: SeedBrandAdminInput,
): Promise<SeedBrandAdminResult> {
  const existingUser = await repo.findUserByKeycloakSub(input.sub);

  let userId: string;
  let user: 'created' | 'kept';
  let emailMismatch: string | null = null;

  if (existingUser) {
    userId = existingUser.id;
    user = 'kept';
    if (existingUser.email && existingUser.email.toLowerCase() !== input.email.toLowerCase()) {
      emailMismatch = existingUser.email;
    }
  } else {
    const created = await repo.upsertUserByKeycloakSub(input.sub, {
      email: input.email,
      name: input.name ?? 'Owner',
      surname: input.surname ?? '',
      birthday: input.birthday ?? '1970-01-01',
      userPrivacyPolicyAcceptance: true,
      userTermsAcceptance: true,
    });
    userId = created.id;
    user = 'created';
  }

  // Read the membership the upsert below will land on, so the seed can report
  // whether it created one or re-roled an existing one. Mirrors the lookup
  // upsertMembership itself does (by business when there is one, else by brand).
  const existingMembership = input.businessId
    ? await repo.getMembership(userId, input.businessId)
    : await repo.getMembershipByBrand(userId, input.brandId);

  await repo.upsertMembership(userId, {
    businessId: input.businessId,
    brandId: input.brandId,
    role: 'ADMIN',
  });

  return { userId, user, membership: existingMembership ? 'updated' : 'created', emailMismatch };
}
