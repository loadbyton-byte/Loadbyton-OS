FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# tsx (a dev dependency) runs the TypeScript sources directly, so dev dependencies are installed too
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p data/files && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["npx", "tsx", "src/server.ts"]
