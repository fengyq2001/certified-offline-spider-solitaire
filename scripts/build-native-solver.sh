#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CARGO_BIN=${CARGO_BIN:-cargo}
TARGET_DIR=${CARGO_TARGET_DIR:-$ROOT/artifacts/native/cargo-target}

mkdir -p "$ROOT/artifacts/native"
cd "$ROOT/tools/solverlab/solver-core-rs"
CARGO_TARGET_DIR="$TARGET_DIR" "$CARGO_BIN" build --release --bin spider_cli
cp "$TARGET_DIR/release/spider_cli" "$ROOT/artifacts/native/solverlab-spider-cli"
echo "Built $ROOT/artifacts/native/solverlab-spider-cli"
