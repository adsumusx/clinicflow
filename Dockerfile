FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV BOOTSTRAP_ENABLED=1
ENV BOOTSTRAP_ORG_NAME="Clínica Taline Vavassori"
ENV BOOTSTRAP_ADMIN_EMAIL=admin@clinicatallinevavassori.local
EXPOSE 3001
CMD ["node", "scripts/start-production.mjs"]
