import type { ServiceResponse } from '@/types/serviceResponse.js';

type HealthPayload = { status: 'ok' };
type ReadinessPayload = { ready: true };
type MetricsPayload = string;

export async function getHealthService(): Promise<ServiceResponse<HealthPayload>> {
  return { statusCode: 200, body: { status: 'ok' } };
}

export async function getReadinessService(): Promise<ServiceResponse<ReadinessPayload>> {
  return { statusCode: 200, body: { ready: true } };
}

export async function getMetricsService(): Promise<ServiceResponse<MetricsPayload>> {
  return { statusCode: 200, body: '# no metrics yet' };
}
