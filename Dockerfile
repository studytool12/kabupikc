# 株ウォッチリスト (Render 用)
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# データの正は DATABASE_URL の Postgres（Neon）。SQLite はアプリ内の
# ワーキングストアで、未指定なら ./data に作られる（再デプロイで消えても
# 起動時に Postgres から復元される）。
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
