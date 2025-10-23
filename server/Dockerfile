FROM node:20-alpine

WORKDIR /app

ARG GITHUB_PACKAGES_TOKEN
ENV GITHUB_PACKAGES_TOKEN=${GITHUB_PACKAGES_TOKEN}

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY types ./types
COPY db ./db
COPY server ./server

ENV CI=true
RUN apk add --no-cache ca-certificates openssl \
	&& printf '@returnacy:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}\nalways-auth=true\n' > .npmrc \
	&& corepack enable \
	&& pnpm config set fetch-retries 5 \
	&& pnpm config set fetch-retry-maxtimeout 120000 \
	&& pnpm config set fetch-retry-mintimeout 20000 \
	&& pnpm config set network-concurrency 1 \
	&& pnpm install --no-frozen-lockfile --reporter=append-only

# Generate Prisma Client for the db package and build its TS outputs before building the server
RUN pnpm --filter @user-service/db exec prisma generate || true \
    && pnpm --filter @user-service/db build

WORKDIR /app/server
RUN pnpm run build

# Copy built db package into server dist as a shim for runtime resolution
RUN mkdir -p ./dist/node_modules/@user-service/db/dist \
	&& cp -r ../db/dist/* ./dist/node_modules/@user-service/db/dist/ \
	&& printf '{"name":"@user-service/db","type":"module","main":"dist/index.js"}' > ./dist/node_modules/@user-service/db/package.json

# Also copy domain mapping into locations our loader will probe
RUN cp domain-mapping.json ./dist/domain-mapping.json || true \
	&& cp domain-mapping.json ./dist/src/domain-mapping.json || true

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/app.js"]
