import { prisma } from './prismaClient.js';
import type { Prisma, User, UserMembership, UserRole } from '@prisma/client';

type WalletPassRecord = {
  id: string;
  userMembershipId: string;
  objectId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class RepositoryPrisma {
  async healthCheck() {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true } as const;
  }

  // Users
  async findUserByKeycloakSub(sub: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { keycloakSub: sub } });
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findFirst({ where: { email } });
  }

  async findUserByGoogleSub(googleSub: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { googleSub } as any });
  }

  async findUserByEmailAndBrand(email: string, brandId: string): Promise<User | null> {
    return prisma.user.findFirst({
      where: {
        email,
        userMemberships: {
          some: { brandId }
        }
      }
    });
  }

  async findUserByEmailAndBusiness(email: string, businessId: string): Promise<User | null> {
    return prisma.user.findFirst({
      where: {
        email,
        userMemberships: {
          some: { businessId }
        }
      }
    });
  }

  async createUser(data: Omit<Prisma.UserCreateInput, 'userMemberships'> & { userMemberships?: Prisma.UserMembershipCreateNestedManyWithoutUserInput }): Promise<User> {
  return prisma.user.create({ data: data as any });
  }

  async upsertUserByKeycloakSub(sub: string, data: Partial<User>): Promise<User> {
    // Build update data without assigning explicit undefined (exactOptionalPropertyTypes)
    const updateData: Prisma.UserUpdateInput = {};
    if (data.email !== undefined) updateData.email = data.email as any;
    if (data.phone !== undefined) updateData.phone = data.phone as any;
    if (data.name !== undefined) updateData.name = data.name as any;
    if (data.surname !== undefined) updateData.surname = data.surname as any;
    if (data.birthday !== undefined) updateData.birthday = data.birthday as any;
    if (data.gender !== undefined) updateData.gender = data.gender as any;
  if ((data as any).preferences !== undefined) (updateData as any).preferences = (data as any).preferences;
  if ((data as any).googleSub !== undefined) (updateData as any).googleSub = (data as any).googleSub ?? null;
    if (data.userPrivacyPolicyAcceptance !== undefined) updateData.userPrivacyPolicyAcceptance = data.userPrivacyPolicyAcceptance as any;
    if (data.userTermsAcceptance !== undefined) updateData.userTermsAcceptance = data.userTermsAcceptance as any;

    return prisma.user.upsert({
      where: { keycloakSub: sub },
      update: updateData,
      create: {
        keycloakSub: sub,
        email: data.email || '',
        phone: data.phone || '',
        name: data.name || '',
        surname: data.surname || '',
        birthday: data.birthday || '',
        gender: data.gender || null,
        preferences: (data as any).preferences ?? {},
  googleSub: (data as any).googleSub ?? null,
        userPrivacyPolicyAcceptance: data.userPrivacyPolicyAcceptance ?? false,
        userTermsAcceptance: data.userTermsAcceptance ?? false,
      } as any,
    });
  }

  // Memberships
  async addMembership(userId: string, membership: { businessId?: string | null; brandId?: string | null; role?: UserRole }): Promise<UserMembership> {
    const businessId = membership.businessId ?? null;
    const brandId = membership.brandId ?? null;
    if (!businessId && !brandId) {
      throw Object.assign(new Error('BUSINESS_OR_BRAND_REQUIRED'), { code: 'BUSINESS_OR_BRAND_REQUIRED' });
    }
    return prisma.userMembership.create({
      data: {
        userId,
        businessId: businessId as any,
        brandId,
        role: membership.role ?? 'USER',
      } as any
    });
  }

  async listMemberships(userId: string): Promise<UserMembership[]> {
    return prisma.userMembership.findMany({ where: { userId } });
  }

  async upsertMembership(userId: string, membership: { businessId?: string | null; brandId?: string | null; role?: UserRole }): Promise<UserMembership> {
    const businessId = membership.businessId ?? null;
    const brandId = membership.brandId ?? null;
    const nextRole = membership.role;

    if (businessId) {
      const existing = await prisma.userMembership.findUnique({ where: { userId_businessId: { userId, businessId } } as any });
      if (existing) {
        return prisma.userMembership.update({
          where: { id: existing.id },
          data: {
            brandId,
            role: nextRole ?? existing.role,
          }
        });
      }
      const payload: { businessId?: string | null; brandId?: string | null; role?: UserRole } = { businessId, brandId };
      if (nextRole) payload.role = nextRole;
      return this.addMembership(userId, payload);
    }

    if (brandId) {
      const existing = await prisma.userMembership.findFirst({ where: { userId, brandId } });
      if (existing) {
        return prisma.userMembership.update({
          where: { id: existing.id },
          data: {
            role: nextRole ?? existing.role,
          }
        });
      }
      const payload: { businessId?: string | null; brandId?: string | null; role?: UserRole } = { businessId: null, brandId };
      if (nextRole) payload.role = nextRole;
      return this.addMembership(userId, payload);
    }

    throw Object.assign(new Error('BUSINESS_OR_BRAND_REQUIRED'), { code: 'BUSINESS_OR_BRAND_REQUIRED' });
  }

  async getMembership(userId: string, businessId: string): Promise<UserMembership | null> {
    return prisma.userMembership.findUnique({ where: { userId_businessId: { userId, businessId } } as any });
  }

  async getMembershipByBrand(userId: string, brandId: string): Promise<UserMembership | null> {
    return prisma.userMembership.findFirst({ where: { userId, brandId } });
  }

  async getMembershipWithWalletPass(userId: string, businessId: string): Promise<(UserMembership & { walletPass: WalletPassRecord | null }) | null> {
    return prisma.userMembership.findUnique({
      where: { userId_businessId: { userId, businessId } } as any,
      include: { walletPass: true } as any,
    }) as any;
  }

  async findWalletPass(userId: string, businessId: string): Promise<WalletPassRecord | null> {
    const membership = await this.getMembershipWithWalletPass(userId, businessId);
    return membership?.walletPass ?? null;
  }

  async upsertWalletPass(userId: string, businessId: string, payload: { objectId?: string | null }): Promise<WalletPassRecord> {
    const membership = await this.getMembership(userId, businessId);
    if (!membership) {
      throw Object.assign(new Error('MEMBERSHIP_NOT_FOUND'), { code: 'MEMBERSHIP_NOT_FOUND' });
    }

    return (prisma as any).walletPass.upsert({
      where: { userMembershipId: membership.id } as any,
      update: {
        objectId: payload.objectId ?? null,
      },
      create: {
        userMembershipId: membership.id,
        objectId: payload.objectId ?? null,
      },
    }) as any;
  }

  async setMembershipCounters(userId: string, businessId: string, counters: { validStamps?: number; validCoupons?: number; totalStampsDelta?: number; totalCouponsDelta?: number }) {
    const existing = await this.getMembership(userId, businessId);
    if (!existing) {
      throw Object.assign(new Error('MEMBERSHIP_NOT_FOUND'), { code: 'MEMBERSHIP_NOT_FOUND' });
    }
    const nextValidStamps = counters.validStamps ?? existing.validStamps;
    const nextValidCoupons = existing.validCoupons + (counters.validCoupons ?? 0);
    const nextTotalStamps = existing.totalStamps + (counters.totalStampsDelta ?? 0);
    const nextTotalCoupons = existing.totalCoupons + (counters.totalCouponsDelta ?? 0);
    return prisma.userMembership.update({
      where: { id: existing.id },
      data: {
        validStamps: nextValidStamps,
        validCoupons: nextValidCoupons,
        totalStamps: nextTotalStamps,
        totalCoupons: nextTotalCoupons,
      },
    });
  }

  // Targeting: fetch candidate users (later add business/brand scope filters)
  async findUsersForTargeting(limit: number): Promise<User[]> {
    return prisma.user.findMany({ take: limit, orderBy: { createdAt: 'desc' } });
  }

  // Targeting with pre-filter by membership businessId
  async findUsersForTargetingByBusiness(businessId: string, limit: number): Promise<User[]> {
    return prisma.user.findMany({
      where: {
        userMemberships: {
          some: { businessId }
        }
      },
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
  }

  // Count users that have a membership for a given business
  async countUsersByBusiness(businessId: string): Promise<number> {
    return prisma.user.count({
      where: {
        userMemberships: {
          some: { businessId }
        }
      }
    });
  }

  async countUsersByBrand(brandId: string): Promise<number> {
    return prisma.user.count({
      where: {
        userMemberships: {
          some: { brandId }
        }
      }
    });
  }

  // Targeting with pre-filter by membership brandId
  async findUsersForTargetingByBrand(brandId: string, limit: number): Promise<User[]> {
    return prisma.user.findMany({
      where: {
        userMemberships: {
          some: { brandId }
        }
      },
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
  }

  // Count new users by membership creation date since a given timestamp
  async countNewUsersSince(businessId: string, since: Date): Promise<number> {
    return prisma.userMembership.count({
      where: {
        businessId,
        createdAt: { gte: since },
      }
    });
  }

  async countNewUsersSinceBrand(brandId: string, since: Date): Promise<number> {
    return prisma.userMembership.count({
      where: {
        brandId,
        createdAt: { gte: since },
      }
    });
  }

  async findUserById(userId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  // Tokens: Email verification
  async createEmailVerificationToken(userId: string, ttlMinutes = 1440) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const token = (await import('node:crypto')).randomBytes(32).toString('base64url');
    return (prisma as any).emailVerificationToken.create({
      data: { userId, token, expiresAt }
    });
  }

  async consumeEmailVerificationToken(token: string) {
    const now = new Date();
    const row = await (prisma as any).emailVerificationToken.findUnique({ where: { token } });
    if (!row || row.usedAt || new Date(row.expiresAt) < now) return null;
    await (prisma as any).emailVerificationToken.update({ where: { token }, data: { usedAt: now } });
    return row;
  }

  // Tokens: Password reset
  async createPasswordResetToken(userId: string, ttlMinutes = 60) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const token = (await import('node:crypto')).randomBytes(32).toString('base64url');
    return (prisma as any).passwordResetToken.create({
      data: { userId, token, expiresAt }
    });
  }

  async consumePasswordResetToken(token: string) {
    const now = new Date();
    const row = await (prisma as any).passwordResetToken.findUnique({ where: { token } });
    if (!row || row.usedAt || new Date(row.expiresAt) < now) return null;
    await (prisma as any).passwordResetToken.update({ where: { token }, data: { usedAt: now } });
    return row;
  }

  // Policies latest versions
  async getLatestPrivacyPolicyVersion(): Promise<string | null> {
    const p = await prisma.privacyPolicy.findFirst({ orderBy: { createdAt: 'desc' } });
    return p?.version ?? null;
  }
  async getLatestTermsOfServiceVersion(): Promise<string | null> {
    const t = await prisma.termsOfService.findFirst({ orderBy: { createdAt: 'desc' } });
    return t?.version ?? null;
  }
  async getLatestMarketingTermsVersion(): Promise<string | null> {
    const m = await prisma.marketingTerms.findFirst({ orderBy: { createdAt: 'desc' } });
    return m?.version ?? null;
  }

  // Acceptances
  async createPrivacyPolicyAcceptance(userId: string, version: string, ipAddress?: string | null, userAgent?: string | null) {
    return prisma.privacyPolicyAcceptance.upsert({
      where: { userId_version: { userId, version } },
      update: {},
      create: { userId, version, ipAddress: ipAddress || null, userAgent: userAgent || null }
    });
  }
  async createTermsOfServiceAcceptance(userId: string, version: string, ipAddress?: string | null, userAgent?: string | null) {
    return prisma.termsOfServiceAcceptance.upsert({
      where: { userId_version: { userId, version } },
      update: {},
      create: { userId, version, ipAddress: ipAddress || null, userAgent: userAgent || null }
    });
  }
  async createMarketingTermsAcceptance(userId: string, version: string, ipAddress?: string | null, userAgent?: string | null) {
    return prisma.marketingTermsAcceptance.upsert({
      where: { userId_version: { userId, version } },
      update: {},
      create: { userId, version, ipAddress: ipAddress || null, userAgent: userAgent || null }
    });
  }
}

export default RepositoryPrisma;
