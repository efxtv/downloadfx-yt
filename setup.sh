#!/usr/bin/env bash
# DownloadFX setup — checks prerequisites and installs whatever is missing,
# so a copied project folder can be rebuilt on a fresh machine with one command.
# Everything lands inside this project folder (or ~/.local/bin for uv).
#   bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33mWARN:\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*"; exit 1; }

ARCH=$(uname -m)
case "$ARCH" in x86_64|amd64) ARCH_URL="x64";; aarch64|arm64) ARCH_URL="arm64";; *) ARCH_URL="";; esac
OSKIND=$(uname -s)

# ---------------------------------------------------------------- Node.js
log "Checking Node.js (18+ required)…"
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
  echo "  → Node $(node --version) found."
elif [ -x bin/node ] && "bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
  echo "  → using bundled bin/node ($(bin/node --version))."
  export PATH="$ROOT/bin:$PATH"
else
  if [ -n "$ARCH_URL" ] && { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }; then
    warn "Node 18+ not found. Downloading a standalone Node into this project folder…"
    case "$OSKIND" in
      Darwin*) PLAT="darwin" ;;
      *)       PLAT="linux" ;;
    esac
    NODE_VER="v22.11.0"
    URL="https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$PLAT-$ARCH_URL.tar.xz"
    TMP=$(mktemp -d)
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$URL" -o "$TMP/node.tar.xz" || die "Could not download Node from $URL"
    else
      wget -q "$URL" -O "$TMP/node.tar.xz" || die "Could not download Node from $URL"
    fi
    mkdir -p runtime bin
    tar -xJf "$TMP/node.tar.xz" -C "$TMP" || die "Extract failed: tar with xz support needed."
    rm -rf runtime/node
    mv "$TMP"/node-"$NODE_VER"-"$PLAT"-"$ARCH_URL" runtime/node
    rm -rf "$TMP"
    ln -sfn ../runtime/node/bin/node bin/node
    ln -sfn ../runtime/node/bin/npm bin/npm
    export PATH="$ROOT/bin:$PATH"
    echo "  → Node $(node --version) bundled into runtime/ (run the app with: bin/node server.js)."
  else
    die "Node.js 18+ is required. Install it, then rerun."
  fi
fi

# ---------------------------------------------------------------- npm (for express)
log "Installing app dependencies (express)…"
if command -v npm >/dev/null 2>&1; then
  npm install --omit=dev --silent
  echo "  → node_modules ready."
else
  warn "npm not found. The app will not start until node_modules is created (npm install)."
fi

# ---------------------------------------------------------------- Python venv + yt-dlp
select_python() {
  # Prefer 3.10..3.13; 3.14+ may lack prebuilt wheels for curl_cffi/cryptography.
  PY_BIN=""
  local cand minor
  for cand in python3.13 python3.12 python3.11 python3.10; do
    command -v "$cand" >/dev/null 2>&1 || continue
    minor=$("$cand" -c 'import sys;print(sys.version_info.minor)' 2>/dev/null) || continue
    case "$minor" in 10|11|12|13) PY_BIN=$cand; return 0 ;; esac
  done
  if command -v python3 >/dev/null 2>&1; then
    minor=$(python3 -c 'import sys;print(sys.version_info.minor)' 2>/dev/null)
    case "$minor" in 10|11|12|13) PY_BIN=python3; return 0 ;; esac
  fi
  return 1
}

log "Building Python venv (yt-dlp + PO-token plugins)…"
rm -rf .venv
if select_python; then
  echo "  → using $PY_BIN ($($PY_BIN --version 2>&1))"
  "$PY_BIN" -m venv .venv || die "Failed to create venv. On Debian/Ubuntu: sudo apt install -y python3-venv"
else
  if command -v python3 >/dev/null 2>&1; then
    warn "Only Python $(python3 --version 2>&1) found (3.14+ may break yt-dlp). Installing standalone Python 3.12 via uv — no root needed."
  else
    warn "No Python found. Installing standalone Python 3.12 via uv — no root needed."
  fi
  if ! command -v uv >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || die "curl is required to bootstrap uv."
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null || die "uv install failed."
    export PATH="$HOME/.local/bin:$PATH"
  fi
  echo "  → installing Python 3.12 (uv managed)…"
  uv python install 3.12 >/dev/null 2>&1 || die "uv could not install Python 3.12."
  uv venv --python 3.12 .venv >/dev/null 2>&1 || die "uv could not create the venv."
  echo "  → Python 3.12 via uv ready."
fi
.venv/bin/pip install --quiet -U pip
.venv/bin/pip install --quiet -U 'yt-dlp[default]' curl_cffi bgutil-ytdlp-pot-provider yt-dlp-ejs
.venv/bin/yt-dlp --version >/dev/null 2>&1 || die "yt-dlp install failed inside the venv."
echo "  → yt-dlp $(.venv/bin/yt-dlp --version)"
if ! .venv/bin/python -c 'import curl_cffi' >/dev/null 2>&1; then
  warn "curl_cffi is missing (browser impersonation). Retrying…"
  .venv/bin/pip install --quiet -U curl_cffi || die "curl_cffi install failed. Run: .venv/bin/pip install -U curl_cffi"
fi
if ! .venv/bin/yt-dlp --list-impersonate-targets 2>/dev/null | grep -q "curl_cffi (available)"; then
  warn "Impersonation targets missing; 4K unlock may fail. Retry: .venv/bin/pip install -U curl_cffi"
fi

# ---------------------------------------------------------------- ffmpeg
log "Setting up ffmpeg/ffprobe…"
mkdir -p bin
if [ -x bin/ffmpeg ] && bin/ffmpeg -version >/dev/null 2>&1; then
  echo "  → existing bin/ffmpeg works — keeping it."
elif command -v ffmpeg >/dev/null 2>&1; then
  cp "$(command -v ffmpeg)" bin/ffmpeg
  cp "$(command -v ffprobe)" bin/ffprobe 2>/dev/null || true
  echo "  → copied system ffmpeg."
elif command -v curl >/dev/null 2>&1 && [ -n "$ARCH_URL" ]; then
  echo "  → downloading static ffmpeg ($ARCH)…"
  TMP=$(mktemp -d)
  curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$ARCH_URL-static.tar.xz" -o "$TMP/ff.tar.xz" \
    || die "ffmpeg download failed. Install ffmpeg manually and rerun."
  tar -xJf "$TMP/ff.tar.xz" -C "$TMP"
  cp "$TMP"/ffmpeg-*/ffmpeg bin/ffmpeg
  cp "$TMP"/ffmpeg-*/ffprobe bin/ffprobe
  rm -rf "$TMP"
  echo "  → static ffmpeg installed."
else
  warn "No ffmpeg found and auto-download unavailable. Install ffmpeg, or downloads that need merging won't work."
fi

# ---------------------------------------------------------------- PO-token provider
log "Setting up PO-token provider (bgutil)…"
PROVIDER_UP=false
( echo > /dev/tcp/127.0.0.1/4416 ) 2>/dev/null && PROVIDER_UP=true

if [ "$PROVIDER_UP" = false ] && command -v docker >/dev/null 2>&1; then
  docker rm -f downloadfx-bgutil >/dev/null 2>&1 || true
  if docker run -d --name downloadfx-bgutil --restart unless-stopped \
    -p 127.0.0.1:4416:4416 brainicism/bgutil-ytdlp-pot-provider:latest >/dev/null 2>&1; then
    echo "  → provider running in Docker."
    PROVIDER_UP=true
  else
    warn "Docker failed; trying a local build…"
  fi
fi

if [ "$PROVIDER_UP" = false ]; then
  if [ -d bgutil-provider ] && [ -f bgutil-provider/build/main.js ] && node -e 'require("./bgutil-provider/node_modules/canvas")' >/dev/null 2>&1; then
    echo "  → existing bgutil-provider build works — keeping it."
  elif command -v npm >/dev/null 2>&1 || [ -x bin/npm ]; then
    NPM_CMD=npm
    command -v npm >/dev/null 2>&1 || NPM_CMD="$ROOT/bin/npm"
    if [ ! -d bgutil-provider ]; then
      command -v git >/dev/null 2>&1 || { warn "bgutil-provider missing and no git to fetch it."; exit 0; }
      echo "  → cloning bgutil-provider…"
      TMP=$(mktemp -d)
      git -c advice.detachedHead=false clone --quiet --depth 1 -b 2.0.0 \
        https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$TMP/repo"
      mkdir -p bgutil-provider
      cp -r "$TMP/repo/server/." bgutil-provider/
      rm -rf "$TMP"
    fi
    echo "  → rebuilding bgutil-provider for this OS (npm ci)…"
    ( cd bgutil-provider && rm -rf node_modules build && "$NPM_CMD" ci --silent && "$NPM_CMD" exec tsc )
    echo "  → provider built."
  else
    warn "No Docker or npm available — 4K PO-token unlock unavailable. The app still works (may cap gated YouTube videos at low quality)."
  fi
fi

# ---------------------------------------------------------------- done
log "Setup finished."
if [ -x bin/node ] && ! command -v node >/dev/null 2>&1; then
  echo "  Run the app with:   bin/node server.js"
else
  echo "  Run the app with:   npm start"
  echo "  Or without npm:     node server.js"
fi