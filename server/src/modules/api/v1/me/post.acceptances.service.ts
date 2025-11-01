import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceResponse } from '@/types/serviceResponse.js';

type AcceptancesResponse = { ok: true; recorded: Record<string, string | undefined> } | { error: string; detail?: unknown };

const acceptancesSchema = z.object({
  acceptPrivacyPolicy: z.boolean().optional(),
  acceptTermsOfService: z.boolean().optional(),
  acceptMarketing: z.boolean().optional(),
}).refine((v) => v.acceptPrivacyPolicy || v.acceptTermsOfService || v.acceptMarketing, {
  message: 'At least one acceptance must be provided',
});

export async function postAcceptancesService(request: FastifyRequest): Promise<ServiceResponse<AcceptancesResponse>> {
  try {
    const auth = (request as any).auth as any;
    if (!auth?.sub) {
      return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
    }

    const input = acceptancesSchema.parse(request.body);
    const repository = (request.server as any).repository as any;
    const sub = auth.sub as string;

    const existing = await repository.findUserByKeycloakSub(sub);
    if (!existing) {
      await repository.upsertUserByKeycloakSub(sub, { email: auth.email || '' });
    }
    const user = await repository.findUserByKeycloakSub(sub);

    const ip = (request.headers['x-forwarded-for'] as string) || request.ip;
    const ua = request.headers['user-agent'] as string | undefined;

    const latestPP = await repository.getLatestPrivacyPolicyVersion();
    const latestTOS = await repository.getLatestTermsOfServiceVersion();
    const latestMT = await repository.getLatestMarketingTermsVersion();

    const recorded: { privacyPolicy?: string; termsOfService?: string; marketing?: string } = {};

    if (input.acceptPrivacyPolicy) {
      if (!latestPP) {
        return { statusCode: 400, body: { error: 'NO_PRIVACY_POLICY_VERSION' } };
      }
      await repository.createPrivacyPolicyAcceptance(user.id, latestPP, ip, ua);
      recorded.privacyPolicy = latestPP;
      await repository.upsertUserByKeycloakSub(sub, { userPrivacyPolicyAcceptance: true });
    }
    if (input.acceptTermsOfService) {
      if (!latestTOS) {
        return { statusCode: 400, body: { error: 'NO_TOS_VERSION' } };
      }
      await repository.createTermsOfServiceAcceptance(user.id, latestTOS, ip, ua);
      recorded.termsOfService = latestTOS;
      await repository.upsertUserByKeycloakSub(sub, { userTermsAcceptance: true });
    }
    if (input.acceptMarketing) {
      if (!latestMT) {
        return { statusCode: 400, body: { error: 'NO_MARKETING_TERMS_VERSION' } };
      }
      await repository.createMarketingTermsAcceptance(user.id, latestMT, ip, ua);
      recorded.marketing = latestMT;
    }

    return { statusCode: 200, body: { ok: true, recorded } };
  } catch (error: any) {
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'ACCEPTANCES_FAILED');
    return { statusCode: 400, body: { error: 'ACCEPTANCES_FAILED', detail } };
  }
}
