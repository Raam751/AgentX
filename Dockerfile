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

# Install npm dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy app source
COPY . .

# Don't copy .env (use platform env vars instead)
RUN rm -f .env

# Expose port
EXPOSE 3000

# Force headless mode in cloud
ENV HEADLESS=true
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
