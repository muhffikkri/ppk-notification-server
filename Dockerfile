FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
EXPOSE 8787

CMD ["node", "src/index.js"]
