FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8000
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8000
CMD ["node", "server.js"]
