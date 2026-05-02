import 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    repository: any;
    keycloakTokenService: { getAccessToken(opts?: { mode?: 'service' | 'admin'; scope?: string }): Promise<string> };
  }
  interface FastifyRequest {
    auth?: any;
  }
}
