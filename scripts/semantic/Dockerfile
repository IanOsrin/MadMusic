# Dockerfile — Render Docker Cron: rebuild the "Similar albums" index from Postgres.
#
# Node only (no ffmpeg — unlike the analyzer). Bakes the embedding model into the
# image so it isn't re-downloaded each run, and bundles the AWS CLI for the S3
# round-trip. Build context = repo ROOT (needs lib/ + package.json).
FROM node:20-slim

# AWS CLI (S3 up/download) + toolchain for any native module that lacks a prebuild.
RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Install dev deps too (the embed model lives in @huggingface/transformers, a
# devDependency) and skip Playwright's browser download.
ENV NODE_ENV=development \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HUSKY=0

COPY package*.json ./
RUN npm ci --include=dev

COPY . .

# Pre-cache the embedding model into the image (~120 MB) so runs don't re-download it.
RUN node -e "import('@huggingface/transformers').then(t=>t.pipeline('feature-extraction','Xenova/multilingual-e5-small',{dtype:'q8'})).then(()=>console.log('[docker] embed model cached')).catch(e=>{console.error(e);process.exit(1)})"

CMD ["npm", "run", "refresh:index"]
