# ============================================================
# Health AI — server image (Next.js standalone).
# Used by cloudbuild.yaml (Cloud Run) and for self-hosting on any Docker host — e.g. a server in Uzbekistan next
# to a self-hosted Supabase. Multi-stage: deps -> build -> runtime. Node 22 LTS, the version CI tests with.
# No secret is ever baked in: the runtime gets them from the host's secret store / environment.
# ============================================================

# ---------- Stage 1: install dependencies -------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- Stage 2: build -----------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they come as build args
# (cloudbuild.yaml). They are public values (Supabase URL + anon key, app URL), not secrets.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN npm run build

# ---------- Stage 3: runtime ---------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone output: the server, the node_modules it needs, and the static files.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8080
# Startup fails closed when required secrets are missing or insecure (src/instrumentation.ts).
CMD ["node", "server.js"]
