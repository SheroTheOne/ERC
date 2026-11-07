# syntax=docker/dockerfile:1

# Beroenden för bygget. Bara package-filer kopieras först, så att lagret
# cachas tills beroendena ändras.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci

FROM deps AS web-build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN npm run build -w @erc/web

# Körmiljö: bara produktionsberoenden för API:t. Node kör TypeScript direkt
# (type stripping, ADR-0011), så inget kompileringssteg behövs.
FROM node:26-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev -w @erc/api && npm cache clean --force
COPY packages/contracts/src packages/contracts/src
COPY apps/api/src apps/api/src
COPY apps/api/db/migrations apps/api/db/migrations
COPY --from=web-build /app/apps/web/dist apps/web/dist

ENV WEB_DIST_DIR=/app/apps/web/dist \
    PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Migreringar körs före start. Migrator tar ett lås, så flera instanser som
# startar samtidigt kör inte samma migrering två gånger (ADR-0006).
CMD ["sh", "-c", "node apps/api/src/db/migrate.ts && exec node apps/api/src/server.ts"]
