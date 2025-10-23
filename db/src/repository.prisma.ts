import { prisma } from './prismaClient.js';
import type { Prisma, User, UserMembership, UserRole } from '@prisma/client';

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

  async createUser(data: Omit<Prisma.UserCreateInput, 'userMemberships'> & { userMemberships?: Prisma.UserMembershipCreateNestedManyWithoutUserInput }): Promise<User> {
    return prisma.user.create({ data });
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
        userPrivacyPolicyAcceptance: data.userPrivacyPolicyAcceptance ?? false,
        userTermsAcceptance: data.userTermsAcceptance ?? false,
      }
    });
  }

  // Memberships
  async addMembership(userId: string, membership: { businessId: string; brandId?: string | null; role?: UserRole }): Promise<UserMembership> {
    return prisma.userMembership.create({
      data: {
        userId,
        businessId: membership.businessId,
        brandId: membership.brandId ?? null,
        role: membership.role ?? 'USER',
      }
    });
  }

  async listMemberships(userId: string): Promise<UserMembership[]> {
    return prisma.userMembership.findMany({ where: { userId } });
  }

  async upsertMembership(userId: string, membership: { businessId: string; brandId?: string | null; role?: UserRole }): Promise<UserMembership> {
    const existing = await prisma.userMembership.findUnique({ where: { userId_businessId: { userId, businessId: membership.businessId } } as any });
    if (existing) {
      return prisma.userMembership.update({
        where: { id: existing.id },
        data: { brandId: membership.brandId ?? null, role: membership.role ?? existing.role }
      });
    }
    return this.addMembership(userId, membership);
  }

  async getMembership(userId: string, businessId: string): Promise<UserMembership | null> {
    return prisma.userMembership.findUnique({ where: { userId_businessId: { userId, businessId } } as any });
  }

  async setMembershipCounters(userId: string, businessId: string, counters: { validStamps?: number; validCoupons?: number; totalStampsDelta?: number; totalCouponsDelta?: number }) {
    const existing = await this.getMembership(userId, businessId);
    if (!existing) {
      // Create membership with provided counters (defaults handled by schema)
      return prisma.userMembership.create({
        data: {
          userId,
          businessId,
          validStamps: counters.validStamps ?? 0,
          validCoupons: counters.validCoupons ?? 0,
          totalStamps: counters.totalStampsDelta ?? 0,
          totalCoupons: counters.totalCouponsDelta ?? 0,
        } as any,
      });
    }
    const nextValidStamps = counters.validStamps ?? existing.validStamps;
    const nextValidCoupons = counters.validCoupons ?? existing.validCoupons;
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

  async findUserById(userId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id: userId } });
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
