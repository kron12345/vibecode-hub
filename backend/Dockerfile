# VibCode Hub Backend — Multi-stage build
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npx nest build

# ─── Production stage ────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY prompts ./prompts

EXPOSE 3100

CMD ["node", "dist/src/main.js"]
