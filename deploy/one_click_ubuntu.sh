#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DOMAIN:-}" ]]; then
  echo "请先设置 DOMAIN 环境变量，例如："
  echo "  export DOMAIN=demo.example.com"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT_DIR}/data"

mkdir -p "${DATA_DIR}"
if [[ ! -f "${DATA_DIR}/roomStates.json" ]]; then
  echo "{}" > "${DATA_DIR}/roomStates.json"
fi

cd "${ROOT_DIR}/deploy"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "未找到 docker compose / docker-compose，请先安装 Docker Compose。"
  exit 1
fi

"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps

echo ""
echo "部署完成："
echo "  http://${DOMAIN}/"
