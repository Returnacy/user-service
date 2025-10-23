FROM node:20-alpine

WORKDIR /app

ARG GITHUB_PACKAGES_TOKEN
ENV GITHUB_PACKAGES_TOKEN=${GITHUB_PACKAGES_TOKEN}

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY types ./types
COPY db ./db

ENV CI=true
RUN apk add --no-cache ca-certificates openssl \
	&& printf '@returnacy:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}\nalways-auth=true\n' > .npmrc \
	&& corepack enable \
	&& (pnpm install --frozen-lockfile --reporter=append-only || pnpm install --no-frozen-lockfile --reporter=append-only)

# Ensure Prisma client is generated for this package
RUN pnpm exec prisma generate --schema=./prisma/schema.prisma || true

WORKDIR /app/db
RUN pnpm run build
