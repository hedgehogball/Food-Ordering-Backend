FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ ./src/
COPY scripts/init-db.js ./scripts/init-db.js
COPY database/ ./database/
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
