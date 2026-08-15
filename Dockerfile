# ============================================================
# Health AI — Cloud Run image (Next.js standalone server).
# Multi-stage: deps -> build -> runtime (distroless).
# ============================================================

# ---------- Stage 1: install dependencies -------------------
FROM node:26-bookworm-slim AS deps
WORKDIR /app

# npm v11 uses a lockfile in the registry + node_modules layout in v11+
# (package-lock.json still present; copy both for cache correctness).
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- Stage 2: build -----------------------------------
FROM node:26-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Do not bake real secrets; Cloud Run injects them via Secret Manager.
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# they must be passed via --build-arg (see cloudbuild.yaml). They are public
# values (Supabase project URL + anon key, app URL), not secrets.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN npm run build

# ---------- Stage 3: runtime ---------------------------------
FROM node:26-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone output: only the server + required node_modules + static.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]