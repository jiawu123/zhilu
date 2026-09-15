FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.30.2

# Pin the official Linux CLI and verify its release-manifest checksum.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) cli_sha=d21691ac3bebeac4fb29f6982da6b4e4dddf659b731cd8f65dea1c0242a7d0ba ;; \
      arm64) cli_sha=1b16d536919d6773a9077d7a316827fd086014f44ae7e1fb2a2c2b23e3efa36a ;; \
      *) exit 1 ;; \
    esac \
    && curl --proto '=https' --tlsv1.2 -fsS -o /tmp/zhihu-cli.tar.gz \
       "https://developer-cdn.zhihu.com/zhihu-cli/releases/beta/cli/0.6.0-beta.20260908125143/zhihu-cli-0.6.0-beta.20260908125143-linux-${TARGETARCH}.tar.gz" \
    && echo "$cli_sha  /tmp/zhihu-cli.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/zhihu-cli.tar.gz -C /usr/local/bin zhihu-cli \
    && rm /tmp/zhihu-cli.tar.gz
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/plan-engine/package.json packages/plan-engine/package.json
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY packages/zhihu/requirements-dotenv.txt packages/zhihu/requirements-dotenv.txt
RUN python3 -m venv /opt/zhilu-python \
    && /opt/zhilu-python/bin/pip install --no-cache-dir -r packages/zhihu/requirements-dotenv.txt
COPY . .
RUN VITE_CLOUDBASE_TRANSPORT=sse pnpm --filter @zhilu/web build

ENV NODE_ENV=production PORT=8080 ZHILU_AUTH_MODE=zhihu \
    ZHILU_DATA_DIR=/mnt/zhilu ZHIHU_CLI_BIN=/usr/local/bin/zhihu-cli \
    ZHIHU_PYTHON_BIN=/opt/zhilu-python/bin/python \
    ZHIHU_PYTHON_CWD=/app/packages/zhihu
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "deploy/cloudbase/start.mjs"]
