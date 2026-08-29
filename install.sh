#!/usr/bin/env bash
# burn installer — usage:
#   curl -fsSL https://raw.githubusercontent.com/JarenKempton/burn/main/install.sh | bash
set -euo pipefail

REPO="JarenKempton/burn"
INSTALL_DIR="${BURN_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "error: unsupported OS $(uname -s) (burn supports Linux and macOS)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

asset="burn-$os-$arch"
url="https://github.com/$REPO/releases/latest/download/$asset"

echo "Installing burn ($os-$arch) to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp)"
if ! curl -fsSL "$url" -o "$tmp"; then
  echo "error: download failed from $url" >&2
  echo "       (no release published yet? check https://github.com/$REPO/releases)" >&2
  exit 1
fi
chmod +x "$tmp"
# mv survives an already-running burn binary; plain cp would fail with ETXTBSY
mv -f "$tmp" "$INSTALL_DIR/burn"

echo "✓ Installed $("$INSTALL_DIR/burn" --version | head -1) to $INSTALL_DIR/burn"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "⚠ $INSTALL_DIR is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Get started:"
echo "  burn server run        # on the machine that keeps history"
echo "  burn collector run     # on each machine that uses AI tools"
