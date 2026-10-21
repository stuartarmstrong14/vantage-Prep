FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
