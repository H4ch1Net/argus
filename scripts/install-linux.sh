#!/usr/bin/env bash
# Argus installer for Kali (and any Debian-family or other Linux). Safe to re-run.
#
#   ./scripts/install-linux.sh                 install deps, the `argus` command,
#                                              a keys file, and desktop launchers
#   ./scripts/install-linux.sh --no-install    skip npm install
#   ./scripts/install-linux.sh --no-desktop    skip the .desktop launchers
#
# Nothing here needs root. Keys stay in ~/.config/argus/.env (mode 600), read
# only by the local proxy, never by the browser.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/argus"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

DO_INSTALL=1
DO_DESKTOP=1
for arg in "$@"; do
  case "$arg" in
    --no-install) DO_INSTALL=0 ;;
    --no-desktop) DO_DESKTOP=0 ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1;32m[argus]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[argus]\033[0m %s\n' "$*"; }

# 1. Node.js: Vite 7 needs 20.19+ or 22.12+.
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed. Install a current one, e.g.:"
  warn "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  warn "  exec \$SHELL && nvm install 22"
  exit 1
fi
if ! node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit((a === 20 && b >= 19) || (a === 22 && b >= 12) || a >= 23 ? 0 : 1);
'; then
  warn "Node $(node -v) is too old (need 20.19+ or 22.12+). Try: nvm install 22"
  exit 1
fi
NODE_BIN="$(command -v node)"
say "Node $(node -v) at ${NODE_BIN}"

# 2. Dependencies (Cesium, Vite, satellite.js, ws, selfsigned).
if [ "$DO_INSTALL" = 1 ]; then
  say "installing dependencies (npm install)..."
  (cd "$REPO" && npm install --no-fund --no-audit)
fi

# 3. The `argus` command.
mkdir -p "$BIN_DIR"
chmod +x "$REPO/bin/argus.js"
ln -sf "$REPO/bin/argus.js" "$BIN_DIR/argus"
say "linked ${BIN_DIR}/argus"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "${BIN_DIR} is not on PATH; add it (Kali adds it at next login if it exists)" ;;
esac

# 4. A private keys file, unless the repo already has a .env.
if [ ! -f "$REPO/.env" ] && [ ! -f "$CONF_DIR/.env" ]; then
  mkdir -p "$CONF_DIR"
  chmod 700 "$CONF_DIR"
  cp "$REPO/.env.example" "$CONF_DIR/.env"
  chmod 600 "$CONF_DIR/.env"
  say "created ${CONF_DIR}/.env: add free keys there for flights (OpenSky), fires, ships"
fi

# 5. Desktop launchers. Exec uses the absolute Node path because desktop
#    sessions often do not see nvm's PATH.
if [ "$DO_DESKTOP" = 1 ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || [ -d "$APP_DIR" ]; }; then
  mkdir -p "$APP_DIR"
  ICON="$REPO/public/icons/icon-512.png"
  cat >"$APP_DIR/argus.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Argus
Comment=Live public-data globe (serves the app + proxy, opens the browser)
Exec="${NODE_BIN}" "${REPO}/bin/argus.js" web --open
Icon=${ICON}
Terminal=true
Categories=Network;Security;Education;
EOF
  cat >"$APP_DIR/argus-terminal.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Argus Terminal
Comment=Argus in the terminal: braille world map, feeds, passive OSINT console
Exec="${NODE_BIN}" "${REPO}/bin/argus.js" tui
Icon=${ICON}
Terminal=true
Categories=Network;Security;Education;
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
  say "added Argus and Argus Terminal to the applications menu"
fi

# 6. GPU check: Cesium refuses software rendering, so the 3D globe needs a real GPU.
if command -v glxinfo >/dev/null 2>&1; then
  RENDERER="$(glxinfo -B 2>/dev/null | sed -n 's/.*OpenGL renderer string: //p' | head -n1)"
  if printf '%s' "$RENDERER" | grep -qiE 'llvmpipe|softpipe|swiftshader|software'; then
    warn "OpenGL renderer is software (${RENDERER}): the 3D globe will refuse to start."
    warn "Fix the GPU (SETUP.md section 2), or use the terminal version: argus tui"
  elif [ -n "$RENDERER" ]; then
    say "GPU: ${RENDERER}"
  fi
else
  warn "glxinfo not found (sudo apt install mesa-utils) to check GPU acceleration"
fi

# 7. Font: the ctOS look is set in JetBrains Mono (any monospace works without it).
if command -v fc-list >/dev/null 2>&1; then
  if fc-list 2>/dev/null | grep -qi 'jetbrains'; then
    say "font: JetBrains Mono found"
  else
    warn "JetBrains Mono not installed (the UI falls back to another monospace)."
    warn "For the intended look: sudo apt install fonts-jetbrains-mono"
  fi
fi

cat <<EOF

  Ready. Common commands:
    argus web --https       globe + proxy on one origin; open the LAN URL on the phone
    argus tui               terminal version (any terminal, SSH too)
    argus tui --demo        terminal version on simulated data, no network
    argus query 8.8.8.8     passive lookup (add --json for scripts)
    argus help              everything else

EOF
