# VibCode Hub Frontend — Multi-stage build
FROM node:22-alpine AS builder

ARG API_URL=http://localhost:3100/api
ARG KEYCLOAK_URL=http://localhost:8081

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Write production environment with build args
RUN echo "export const environment = { \
  production: true, \
  apiUrl: '${API_URL}', \
  keycloak: { \
    url: '${KEYCLOAK_URL}', \
    realm: 'vibcodehub', \
    clientId: 'vibcodehub-frontend' \
  } \
};" > src/environments/environment.prod.ts

RUN npx ng build --configuration production

# ─── Production stage (Nginx) ───────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/dist/frontend/browser /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
