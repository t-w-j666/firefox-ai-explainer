#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

[[ -f requirements.txt ]] || { echo "缺少 requirements.txt" >&2; exit 1; }

python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
echo "完成。激活: source .venv/bin/activate"
