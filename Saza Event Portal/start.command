#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.gemini/antigravity-ide/bin:${PATH}"

echo "=================================================="
echo "    🚀 Стартиране на SaZa Event Portal & Tunnel"
echo "=================================================="

# Стартиране на Cloudflare тунела във фонов режим
cloudflared tunnel run saza-event-portal > /dev/null 2>&1 &
TUNNEL_PID=$!

# Функция за безопасно спиране при затваряне
cleanup() {
  kill $TUNNEL_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# Отваряне на сайта в браузъра
(sleep 2 && open "https://www.sandurek.com") &

# Стартиране на Node.js HTTP сървъра
node --experimental-strip-types src/server/http/server.ts
