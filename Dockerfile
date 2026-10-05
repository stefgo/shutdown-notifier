# Builder Stage
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runner Stage
# The notifier has no runtime dependencies: Node alone watches the file and posts the
# notification, so nothing but the build output goes into the image.
FROM gcr.io/distroless/nodejs22-debian12

ENV NODE_ENV=production

WORKDIR /app

# package.json is what makes Node read dist/*.js as ES modules.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist

# The default template. Mount a file of your own over it to change the notification.
COPY config/template.json /config/template.json

CMD ["dist/index.js"]
