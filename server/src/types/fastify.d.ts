import 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    repository: any;
    keycloakTokenService: { getAccessToken(): Promise<string | null> };
  }
  interface FastifyRequest {
    auth?: any;
  }
}
