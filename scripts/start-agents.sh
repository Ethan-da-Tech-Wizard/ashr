#!/usr/bin/env bash
# Usage: scripts/start-agents.sh auth tests docs
# Creates tmux session "ashr" with one window per name, each a git worktree
# ../ashr-wt-<name> running claude with the ashr hooks. Override repo with REPO=/path.
set -euo pipefail

if [ "$#" -lt 1 ]; then echo "usage: $0 <name> [name...]" >&2; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="${REPO:-$ROOT}"
# Claude Code settings that register the ashr permission and event hooks.
SETTINGS="$ROOT/hooks/claude-settings.json"
# tmux session name; the hub's tmux target syntax (ashr:<window>) relies on it.
SESSION=ashr

if [ -z "${ASHR_SECRET_SHIELD:-}" ]; then
  for p in "$ROOT/../git-secret-shield"; do
    if [ -d "$p" ]; then
      export ASHR_SECRET_SHIELD="$p"
      break
    fi
  done
fi

# Load saved API keys so agents started in tmux inherit them (set -a exports everything sourced).
if [ -f "$HOME/.config/ashr/keys.env" ]; then
  set -a
  source "$HOME/.config/ashr/keys.env" 2>/dev/null || true
  set +a
fi

# Validate every name up front: it becomes a git branch, folder and tmux window name, so only [A-Za-z0-9_-] is allowed.
for arg in "$@"; do
  name="${arg#*:}"
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad name: $name" >&2; exit 1; }
done

# Each argument is "name" (Claude) or "agent:name" with agent = claude, gemini or grok.
i=0
for arg in "$@"; do
  if [[ "$arg" == *":"* ]]; then
    agent="${arg%%:*}"
    name="${arg#*:}"
  else
    agent="claude"
    name="$arg"
  fi
  # Each agent gets its own git worktree on branch ashr/<name>, so parallel agents never edit the same files.
  dir="$(dirname "$REPO")/ashr-wt-$name"
  if [ -d "$dir" ]; then
    echo "worktree exists: $dir"
  # Try a new branch first, then an existing one; fall back to a plain folder if the repo has no commits yet.
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
    # First agent creates the session; later ones add windows to it.
    if [ "$i" -eq 0 ] && ! tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux new-session -d -s "$SESSION" -n "$name" -c "$dir"
    else
      tmux new-window -t "$SESSION:" -n "$name" -c "$dir"
    fi
    # Launch the chosen CLI in the window. Claude gets the hook settings; Grok runs the guarded runner script.
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
