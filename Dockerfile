# Builder Stage
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json .npmrc ./

# GitHub Packages wants a token even for a public package (@stefgo/js-template-engine).
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# What is left is what the notifier needs to run. No token: pruning only removes.
RUN npm prune --omit=dev

# Runner Stage
# Node alone watches the file, posts the notification and speaks MQTT. The one runtime
# dependency is the template engine, which has none of its own.
FROM gcr.io/distroless/nodejs22-debian12

ENV NODE_ENV=production

WORKDIR /app

# package.json is what makes Node read dist/*.js as ES modules.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# The default template. Mount a file of your own over it to change the notification.
COPY config/template.json /config/template.json

CMD ["dist/index.js"]
