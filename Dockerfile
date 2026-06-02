# ── Build stage ───────────────────────────────────────────────
FROM node:20-slim AS base

# Install dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin Playwright browser install path so it's the same at build & runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/app/pw-browsers

# Install npm dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium to the pinned path
RUN npx playwright install chromium

# Copy app source
COPY . .

# Don't copy .env (use platform env vars instead)
RUN rm -f .env

# Create writable directories (HF Spaces runs as non-root)
RUN mkdir -p /app/screenshots /app/logs && \
    chmod -R 777 /app/screenshots /app/logs /app/pw-browsers

# Expose port (HF Spaces expects 7860)
EXPOSE 7860

# Runtime env
ENV HEADLESS=true
ENV PORT=7860
ENV NODE_ENV=production
ENV HOME=/app

CMD ["node", "server.js"]
