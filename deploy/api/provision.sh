#!/usr/bin/env bash
# One-time host setup for the Pact Pay API on Ubuntu 24.04 (arm64 or amd64). Safe to run again.
# Run on the VM from a copy of this directory:  sudo bash provision.sh api.pactagent.app
set -euo pipefail
domain=${1:?usage: provision.sh <api domain>}
here=$(cd "$(dirname "$0")" && pwd)
NODE_MAJOR=24
PNPM_VERSION=11.17.0
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get upgrade -yq
apt-get install -yq --no-install-recommends ca-certificates curl gnupg debian-keyring debian-archive-keyring \
  apt-transport-https sqlite3 rsync ufw build-essential python3 xz-utils

# 2 GB swap: headroom for dependency installs on a 2 GB machine.
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js: the official tarball, checked against the published SHA-256.
case $(dpkg --print-architecture) in arm64) narch=arm64 ;; amd64) narch=x64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
version=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import sys,json; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v$NODE_MAJOR.')))")
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$version" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$version/node-$version-linux-$narch.tar.xz"
  expected=$(curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" | awk -v f="node-$version-linux-$narch.tar.xz" '$2==f{print $1}')
  echo "$expected  $tmp/node.tar.xz" | sha256sum -c --quiet -
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/node.tar.xz" -C /usr/local/lib/nodejs --strip-components=1
  rm -rf "$tmp"
fi
for bin in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$bin" "/usr/local/bin/$bin"; done
if [ "$(/usr/local/bin/pnpm -v 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  /usr/local/bin/npm install -g --no-fund --no-audit "pnpm@$PNPM_VERSION" >/dev/null
fi
ln -sf /usr/local/lib/nodejs/bin/pnpm /usr/local/bin/pnpm

# Caddy from its official apt repository.
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

# Service account and directories. Code belongs to the deploy user (ubuntu) and is read-only to the service.
id pact >/dev/null 2>&1 || useradd --system --home-dir /var/lib/pact-api --no-create-home --shell /usr/sbin/nologin pact
install -d -o ubuntu -g ubuntu -m 755 /opt/pact-pay
install -d -o pact -g pact -m 750 /var/lib/pact-api /var/lib/pact-api/backups
install -d -o root -g pact -m 750 /etc/pact-api
[ -f /etc/pact-api/api.env ] || install -o root -g pact -m 640 /dev/null /etc/pact-api/api.env

# Units, proxy, firewall, log size.
install -m 644 "$here/pact-api.service" "$here/pact-api-backup.service" "$here/pact-api-backup.timer" /etc/systemd/system/
sed "s/{API_DOMAIN}/$domain/" "$here/Caddyfile.template" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=300M\n' > /etc/systemd/journald.conf.d/pact.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable --now pact-api-backup.timer >/dev/null
systemctl enable pact-api >/dev/null
systemctl reload-or-restart caddy
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null

echo "provisioned: node $(node -v), pnpm $(pnpm -v), $(caddy version | cut -d' ' -f1), domain $domain"
