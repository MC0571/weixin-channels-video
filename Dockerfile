FROM node:24-alpine

ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY --chown=node:node src ./src
COPY --chown=node:node server ./server

USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]
