FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
# build:image compiles each package without its tests or the database test
# helpers, which exist only to run the test suite.
RUN pnpm install --frozen-lockfile && pnpm build:image

# The runtime installs production dependencies from the lockfile into a clean
# directory and takes only compiled output from the build stage, so no
# compiler, test runner or linter ships in the image.
FROM node:22-alpine AS runtime
WORKDIR /app
# The spool and state directories are created here, owned by the runtime
# user, because Docker copies a directory's ownership into a named volume the
# first time it is mounted. Without this the volumes are root-owned and the
# redirect cannot write a single click.
RUN corepack enable \
 && addgroup -S clickmonk && adduser -S clickmonk -G clickmonk \
 && mkdir -p /var/lib/clickmonk/spool /var/lib/clickmonk/state \
 && chown -R clickmonk:clickmonk /var/lib/clickmonk
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ipdata/package.json packages/ipdata/
COPY packages/redirect/package.json packages/redirect/
COPY packages/worker/package.json packages/worker/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --prod
COPY packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/ipdata/dist packages/ipdata/dist
COPY --from=build /app/packages/redirect/dist packages/redirect/dist
COPY --from=build /app/packages/worker/dist packages/worker/dist
COPY --from=build /app/packages/cli/dist packages/cli/dist
USER clickmonk
EXPOSE 8080
CMD ["node", "packages/redirect/dist/index.js"]
