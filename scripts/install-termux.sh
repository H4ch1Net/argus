#!/data/data/com.termux/files/usr/bin/env bash
# Argus on Android, standalone, in Termux (https://termux.dev, install it from
# F-Droid or GitHub, not the outdated Play Store build). Safe to re-run.
#
#   bash scripts/install-termux.sh
#
# Afterwards, on the phone itself:
#   argus web --open      the globe in Chrome at http://localhost:8787
#                         (localhost counts as secure, so location, compass
#                          and "Install app" work without any certificate)
#   argus tui             the terminal version, right in Termux
#
# Keys live in ~/.config/argus/.env (mode 600), read only by the local proxy.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/argus"

say() { printf '\033[1;32m[argus]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[argus]\033[0m %s\n' "$*"; }

case "${PREFIX:-}" in
  *com.termux*) ;;
  *)
    warn "This script is for Termux on Android. On Kali/Linux use scripts/install-linux.sh"
    exit 1
    ;;
esac

# 1. Node.js + git from Termux's own repository (Vite 7 needs Node 20.19+ / 22.12+).
# Install only what is missing: nodejs-lts and nodejs conflict, so an existing
# Node (either package) is kept as it is and only its version is checked below.
if ! command -v node >/dev/null 2>&1; then
  say "installing Node.js (pkg install nodejs-lts)..."
  pkg install -y nodejs-lts
fi
if ! command -v git >/dev/null 2>&1; then
  say "installing git (pkg install git)..."
  pkg install -y git
fi
if ! node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit((a === 20 && b >= 19) || (a === 22 && b >= 12) || a >= 23 ? 0 : 1);
'; then
  warn "Node $(node -v) is too old. Try: pkg upgrade (or pkg install nodejs for the current release)"
  exit 1
fi
say "Node $(node -v)"

# 2. Dependencies. The lockfile includes the Android builds of Vite's native
#    helpers (esbuild, rollup), so a plain install works on arm64 phones.
say "installing dependencies (npm install, a few minutes on a phone)..."
(cd "$REPO" && npm install --no-fund --no-audit)

# 3. The `argus` command, on Termux's PATH.
chmod +x "$REPO/bin/argus.js"
ln -sf "$REPO/bin/argus.js" "$PREFIX/bin/argus"
say "linked $PREFIX/bin/argus"

# 4. A private keys file.
if [ ! -f "$REPO/.env" ] && [ ! -f "$CONF_DIR/.env" ]; then
  mkdir -p "$CONF_DIR"
  chmod 700 "$CONF_DIR"
  cp "$REPO/.env.example" "$CONF_DIR/.env"
  chmod 600 "$CONF_DIR/.env"
  say "created ${CONF_DIR}/.env: add free keys there for OpenSky, fires, ships"
fi

# 5. Home-screen shortcuts for the Termux:Widget add-on (optional).
mkdir -p "$HOME/.shortcuts"
cat >"$HOME/.shortcuts/Argus globe" <<EOF
#!/data/data/com.termux/files/usr/bin/env bash
# Keep the server alive with the screen off, then open the globe in Chrome.
command -v termux-wake-lock >/dev/null && termux-wake-lock
exec "$(command -v node)" "$REPO/bin/argus.js" web --open
EOF
cat >"$HOME/.shortcuts/Argus terminal" <<EOF
#!/data/data/com.termux/files/usr/bin/env bash
exec "$(command -v node)" "$REPO/bin/argus.js" tui
EOF
chmod +x "$HOME/.shortcuts/Argus globe" "$HOME/.shortcuts/Argus terminal"
say "added Termux:Widget shortcuts (install the Termux:Widget app to use them)"

# 6. Build the web app once now, so the first `argus web` starts instantly
#    (it rebuilds itself later whenever the code changes).
say "building the web app (npm run build)..."
(cd "$REPO" && npm run build)

cat <<EOF

  Ready. On this phone:
    argus web --open        globe in Chrome at http://localhost:8787
    argus tui               terminal version (tap to select; use the extra-keys row)
    argus query 8.8.8.8     passive lookups (add --json)

  Tips:
    termux-wake-lock        keep the server running while the screen is off
    Chrome menu > Install app (or Add to Home screen) for a full-screen globe

EOF
