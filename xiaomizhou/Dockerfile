FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile --prod
COPY server.js plugin-runner.js qq-bridge.js qqbot-bridge.js wecom-bridge.js rebate-automation.js ai-brain.js ./
COPY public ./public
ENV PORT=8090 DATA_DIR=/app/data
EXPOSE 8090
VOLUME /app/data
CMD ["node", "server.js"]
