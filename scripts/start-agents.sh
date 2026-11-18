#!/usr/bin/env bash
# Usage: scripts/start-agents.sh auth tests docs
# Creates tmux session "ashr" with one window per name, each a git worktree
# ../ashr-wt-<name> running claude with the ashr hooks. Override repo with REPO=/path.
set -euo pipefail

if [ "$#" -lt 1 ]; then echo "usage: $0 <name> [name...]" >&2; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="${REPO:-$ROOT}"
SETTINGS="$ROOT/hooks/claude-settings.json"
SESSION=ashr

if [ -z "${ASHR_SECRET_SHIELD:-}" ]; then
  for p in "$ROOT/../git-secret-shield"; do
    if [ -d "$p" ]; then
      export ASHR_SECRET_SHIELD="$p"
      break
    fi
  done
fi

if [ -f "$HOME/.config/ashr/keys.env" ]; then
  set -a
  source "$HOME/.config/ashr/keys.env" 2>/dev/null || true
  set +a
fi

for arg in "$@"; do
  name="${arg#*:}"
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad name: $name" >&2; exit 1; }
done

i=0
for arg in "$@"; do
  if [[ "$arg" == *":"* ]]; then
    agent="${arg%%:*}"
    name="${arg#*:}"
  else
    agent="claude"
    name="$arg"
  fi
  dir="$(dirname "$REPO")/ashr-wt-$name"
  if [ -d "$dir" ]; then
    echo "worktree exists: $dir"
  elif git -C "$REPO" worktree add -q "$dir" -b "ashr/$name" 2>/dev/null \
    || git -C "$REPO" worktree add -q "$dir" "ashr/$name" 2>/dev/null; then
    echo "worktree created: $dir (branch ashr/$name)"
  else
    mkdir -p "$dir"
    echo "warning: git worktree failed (no commits yet?), using plain dir $dir"
  fi
  if tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$name"; then
    echo "window $SESSION:$name already exists"
  else
    if [ "$i" -eq 0 ] && ! tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux new-session -d -s "$SESSION" -n "$name" -c "$dir"
    else
      tmux new-window -t "$SESSION:" -n "$name" -c "$dir"
    fi
    if [ "$agent" = "gemini" ]; then
      tmux send-keys -t "$SESSION:$name" "gemini" Enter
      echo "window $SESSION:$name -> gemini in $dir"
    elif [ "$agent" = "grok" ]; then
      tmux send-keys -t "$SESSION:$name" "node '$ROOT/scripts/grok-agent.mjs'" Enter
      echo "window $SESSION:$name -> grok in $dir"
    else
      tmux send-keys -t "$SESSION:$name" "claude --settings '$SETTINGS'" Enter
      echo "window $SESSION:$name -> claude in $dir"
    fi
  fi
  i=$((i + 1))
done

echo "Started $i agent(s). Attach with: tmux attach -t $SESSION"
