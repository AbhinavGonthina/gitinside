#!/bin/sh
# Installs this repo's git hooks by pointing core.hooksPath at scripts/hooks.
# Run once after cloning:  sh scripts/setup-hooks.sh
# On Windows PowerShell:   .\scripts\setup-hooks.ps1
set -e

root=$(git rev-parse --show-toplevel)
chmod +x "$root/scripts/hooks/"* 2>/dev/null || true
git -C "$root" config core.hooksPath scripts/hooks

echo "Hooks installed: core.hooksPath = scripts/hooks"
