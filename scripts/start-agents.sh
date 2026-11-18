#!/usr/bin/env bash
# Program: ashr - start-agents.sh
# Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
# Last Modified: 2026-11-18
# Purpose: Starts one tmux window per agent name, each in its own git worktree, running Claude (with the ashr hooks), Gemini or the Grok agent script.
# Usage: scripts/start-agents.sh auth tests docs
# Creates tmux session "ashr" with one window per name, each a git worktree
# ../ashr-wt-<name> running claude with the ashr hooks. Override repo with REPO=/path.
# Stop on errors, unset variables and pipe failures.
set -euo pipefail

# Need at least one agent name.
if [ "$#" -lt 1 ]; then echo "usage: $0 <name> [name...]" >&2; exit 1; fi

# Locate the repo root; REPO (the repo to branch from), the hooks settings file and the tmux session name.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="${REPO:-$ROOT}"
SETTINGS="$ROOT/hooks/claude-settings.json"
SESSION=ashr

# Use a sibling git-secret-shield folder if the variable is not set.
if [ -z "${ASHR_SECRET_SHIELD:-}" ]; then
  for p in "$ROOT/../git-secret-shield"; do
    if [ -d "$p" ]; then
      export ASHR_SECRET_SHIELD="$p"
      break
    fi
  done
fi

# Load API keys from the user's key file if it exists. set -a exports every variable it defines.
if [ -f "$HOME/.config/ashr/keys.env" ]; then
  set -a
  source "$HOME/.config/ashr/keys.env" 2>/dev/null || true
  set +a
fi

# First pass: check every name is safe (letters, digits, dash, underscore) before starting anything.
for arg in "$@"; do
  name="${arg#*:}"
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad name: $name" >&2; exit 1; }
done

# Second pass: each argument is "name" (a Claude agent) or "agent:name" (for example gemini:docs).
i=0
for arg in "$@"; do
  if [[ "$arg" == *":"* ]]; then
    agent="${arg%%:*}"
    name="${arg#*:}"
  else
    agent="claude"
    name="$arg"
  fi
  # Pick the worktree folder next to the repo. Create it with a new branch ashr/<name>, reuse the branch if it exists, or fall back to a plain folder.
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
  # Skip if a window with that name already exists; otherwise create the tmux session or a new window, then send the command for the agent type.
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

# Report how many agents were started and how to attach.
echo "Started $i agent(s). Attach with: tmux attach -t $SESSION"
