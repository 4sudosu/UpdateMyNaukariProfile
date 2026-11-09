#!/usr/bin/env bash
# UpdateMyNaukariProfile — one-line VPS setup (Ubuntu/Debian).
# Usage: WEB_PASSWORD=your-password bash <(curl -fsSL https://raw.githubusercontent.com/4sudosu/UpdateMyNaukariProfile/main/setup.sh)
set -e

# 1) Node >=18 (install Node 20 if missing/too old)
need_node=0
command -v node >/dev/null 2>&1 || need_node=1
if [ "$need_node" = "0" ]; then
  major=$(node -v | cut -d. -f1 | tr -d 'v')
  [ "$major" -lt 18 ] && need_node=1
fi
if [ "$need_node" = "1" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs git
fi

# 2) Clone or update
if [ -d UpdateMyNaukariProfile ]; then
  cd UpdateMyNaukariProfile
  git pull --ff-only || true
else
  git clone https://github.com/4sudosu/UpdateMyNaukariProfile.git
  cd UpdateMyNaukariProfile
fi

# 3) Deps (headless Chromium via @sparticuz/chromium — no GUI needed)
npm install

# 4) .env (only panel password + port)
if [ ! -f .env ]; then
  echo "PORT=3000" > .env
  echo "WEB_PASSWORD=${WEB_PASSWORD:-change-me-strong}" >> .env
fi

echo "Setup done. Start with: npm start"
echo "Or keep it running: npm install -g pm2 && pm2 start index.js --name naukri && pm2 save"
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):3000 (log in with your panel password)"
