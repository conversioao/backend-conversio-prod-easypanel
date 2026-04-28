# ==================== STAGE 1: Build ====================
FROM node:20-alpine AS builder

WORKDIR /app

# Instalar dependências (incluindo devDependencies para compilar TS)
COPY package.json package-lock.json* ./
RUN npm ci

# Copiar o código fonte e compilar TypeScript
COPY . .
RUN npm run build

# ==================== STAGE 2: Production ====================
FROM node:20-alpine AS production

# tini para gestão correta de sinais (PID 1)
RUN apk add --no-cache tini

WORKDIR /app

# Instalar apenas dependências de produção
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copiar o build compilado do stage anterior
COPY --from=builder /app/build ./build

# Usar utilizador não-root por segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Variáveis de ambiente (substituíveis no Easypanel)
ENV NODE_ENV=production
ENV PORT=8000

# Healthcheck para o Easypanel monitorar o estado
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8000/api/health || exit 1

EXPOSE 8000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/api.js"]
