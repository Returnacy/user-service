# User Service

Fastify-based microservice handling user registration/login integrated with Keycloak, following the same structure as campaign-service and messaging-service.

- db: Prisma schema and repository
- server: Fastify app, Keycloak plugins, routes
- types: zod types and request payload schemas

## Endpoints
- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/handoff — short-lived token handing a logged-in user to an external service of the same brand; configured with the `HANDOFF_TARGETS` env var, see `docs/SSO-HANDOFF-CONTRACT.md`

See docs in `docs/user-service` (to be added).
