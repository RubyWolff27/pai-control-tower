#!/bin/bash
set -euo pipefail

# Only run in Claude Code remote environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Ensure Bun is on PATH for this session
echo 'export PATH="/root/.bun/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
export PATH="/root/.bun/bin:$PATH"

# Create PAI runtime directories
mkdir -p ~/.claude/Tools/public
mkdir -p ~/.claude/data

# Install PAI Control Tower files (idempotent)
cp "$CLAUDE_PROJECT_DIR/src/ControlTower.ts" ~/.claude/Tools/ControlTower.ts
cp "$CLAUDE_PROJECT_DIR/src/ct-types.ts" ~/.claude/Tools/ct-types.ts
cp "$CLAUDE_PROJECT_DIR/src/public/control-tower.html" ~/.claude/Tools/public/control-tower.html

# Start Control Tower server if not already running
if ! pgrep -f "ControlTower.ts" > /dev/null 2>&1; then
  nohup bun ~/.claude/Tools/ControlTower.ts > ~/.claude/data/control-tower.log 2>&1 &
  echo "PAI Control Tower started on http://localhost:8895 (PID: $!)"
else
  echo "PAI Control Tower already running on http://localhost:8895"
fi
