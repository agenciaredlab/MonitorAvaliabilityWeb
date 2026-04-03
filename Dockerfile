# ──────────────────────────────────────────────────────────────────────────────
# Dockerfile — MonitorAvaliabilityWeb
# Created by Agencia Redlab | Developed by Juan Camilo Medina Godoy
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm install --production --no-audit --no-fund

# Copy application source
COPY src/ ./src/
COPY public/ ./public/

# Ensure non-root ownership
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/stats || exit 1

CMD ["node", "src/scheduler.js"]
