#!/bin/sh
# xVine launcher for Linux (and macOS). Uses your Node if it is new enough;
# otherwise offers to fetch the official Node LTS into ./runtime (checksum
# verified). Arguments pass through, e.g.  ./start-xvine.sh --no-open
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_VERSION=24.21.0
RUNTIME="$HERE/runtime"

# Node >= 22.15 has everything xVine uses (node:sqlite with FTS5, zstd).
node_ok() {
	"$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=15)?0:1)' 2>/dev/null
}

pick_node() {
	if [ -x "$RUNTIME/node/bin/node" ] && node_ok "$RUNTIME/node/bin/node"; then
		echo "$RUNTIME/node/bin/node"
		return 0
	fi
	if command -v node >/dev/null 2>&1 && node_ok node; then
		command -v node
		return 0
	fi
	return 1
}

fetch() { # url outfile
	if command -v curl >/dev/null 2>&1; then
		curl -fL --progress-bar -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q --show-progress -O "$2" "$1"
	else
		echo "Neither curl nor wget is installed; cannot download Node." >&2
		return 1
	fi
}

install_node() {
	case "$(uname -s)" in
		Linux) os=linux ;;
		Darwin) os=darwin ;;
		*) echo "Unsupported system: $(uname -s)" >&2; return 1 ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		armv7l) arch=armv7l ;;
		*) echo "Unsupported CPU: $(uname -m)" >&2; return 1 ;;
	esac
	name="node-v$NODE_VERSION-$os-$arch"
	base="https://nodejs.org/dist/v$NODE_VERSION"
	tmp="$RUNTIME/.download"
	rm -rf "$tmp"
	mkdir -p "$tmp"
	echo "Downloading $name.tar.gz from nodejs.org ..."
	fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz"
	fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
	want=$(grep " $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)
	if command -v sha256sum >/dev/null 2>&1; then
		got=$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1)
	else
		got=$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)
	fi
	if [ -z "$want" ] || [ "$want" != "$got" ]; then
		echo "Checksum mismatch for $name.tar.gz; not installing it." >&2
		rm -rf "$tmp"
		return 1
	fi
	tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
	rm -rf "$RUNTIME/node"
	mv "$tmp/$name" "$RUNTIME/node"
	rm -rf "$tmp"
	echo "Node $NODE_VERSION installed in $RUNTIME/node (only xVine uses it)."
}

if ! NODE=$(pick_node); then
	have=$(node -v 2>/dev/null | head -n 1) || true
	[ -n "$have" ] || have=none
	echo "xVine needs Node.js 22.15 or newer (found: $have)."
	if [ -t 0 ]; then
		printf "Download Node %s (about 50 MB) from nodejs.org into %s? [y/N] " "$NODE_VERSION" "$RUNTIME"
		read -r answer
		case "$answer" in
			y | Y | yes | YES) install_node ;;
			*) echo "Install Node 22.15+ yourself (https://nodejs.org/) and run this again."; exit 1 ;;
		esac
	else
		echo "Run this script in a terminal to download Node, or install Node 22.15+ yourself."
		exit 1
	fi
	NODE=$(pick_node) || { echo "Node setup failed." >&2; exit 1; }
fi

exec "$NODE" "$HERE/server/main.js" "$@"
