#!/usr/bin/env bash
# Builds the plugin, packs it, and prepares the demo backend and storefront.
# Needs Node >= 22 and git. No Postgres needed: `npm run db` in demo/backend
# starts an embedded one.
set -euo pipefail
cd "$(dirname "$0")"
DEMO="$PWD"
ROOT="$(dirname "$DEMO")"
STARTER_REPO="https://github.com/medusajs/nextjs-starter-medusa.git"
STARTER_COMMIT="9818886f06e493cb2249733d114d339aa216ef00"

echo "==> Building and packing the plugin"
(cd "$ROOT" && npm install && npm run build && npm pack --pack-destination "$DEMO" >/dev/null)
mv -f "$DEMO"/breeztech-medusa-payment-lightning-*.tgz "$DEMO/medusa-payment-lightning.tgz"

echo "==> Installing the demo backend"
# Installing the tarball by path (not just `npm install`) makes npm pick up a rebuilt plugin
# instead of the cached one recorded in the lockfile.
(cd "$DEMO/backend" && npm install --no-audit --no-fund "$DEMO/medusa-payment-lightning.tgz")
[ -f "$DEMO/backend/.env" ] || cp "$DEMO/backend/.env.template" "$DEMO/backend/.env"

echo "==> Preparing the demo storefront (Medusa Next.js starter + Lightning overlay)"
if [ ! -d "$DEMO/storefront/.git" ]; then
  git clone "$STARTER_REPO" "$DEMO/storefront"
fi
(cd "$DEMO/storefront" && git fetch -q origin && git checkout -q "$STARTER_COMMIT")
cp -R "$DEMO/storefront-overlay/src/." "$DEMO/storefront/src/"
(cd "$DEMO/storefront" && npm install --no-audit --no-fund && npm install --no-audit --no-fund --no-save "$DEMO/medusa-payment-lightning.tgz")
[ -f "$DEMO/storefront/.env.local" ] || cp "$DEMO/storefront-overlay/.env.local.template" "$DEMO/storefront/.env.local"

cat <<MSG

Done. Next, in three terminals:

  1. cd demo/backend && npm run db                 # embedded Postgres
  2. cd demo/backend && npm run setup && npm run dev
     # first run only: edit demo/backend/.env, set LIGHTNING_ADDRESS to your Glow address
     # setup migrates, seeds the demo store and creates admin@example.com / supersecret
  3. cd demo/storefront && npm run dev
     # set NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY in demo/storefront/.env.local first:
     # copy it from http://localhost:9000/app/settings/publishable-api-keys

Store: http://localhost:8000    Admin: http://localhost:9000/app
MSG
