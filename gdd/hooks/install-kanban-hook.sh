#!/usr/bin/env bash
# install-kanban-hook.sh — install the kanban → GitHub auto-sync git hook (G4.S5.T15).
#
# Ships with the gdd/ package (G4.S6.T3). Sets `git config core.hooksPath` to the
# gdd/ package's `hooks/` directory, so the post-commit hook ships with the repo
# and every clone can install it. Run from the repo root (or with $1 = repo root):
#
#   bash gdd/hooks/install-kanban-hook.sh
set -u

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$REPO_ROOT" ] && { echo "error: not in a git repo (or pass the repo root as \$1)" >&2; exit 1; }

# The gdd hooks dir relative to the repo root: <repo>/gdd/hooks.
HOOKS_DIR="$(cd "$REPO_ROOT/gdd/hooks" 2>/dev/null && pwd)" || {
  echo "error: $REPO_ROOT/gdd/hooks not found (is the gdd/ package installed?)" >&2
  exit 1
}
HOOK="$HOOKS_DIR/post-commit"

[ -f "$HOOK" ] || { echo "error: $HOOK not found" >&2; exit 1; }
chmod +x "$HOOK"

# Point git at the gdd hooks dir (relative, so it works across clones).
git -C "$REPO_ROOT" config core.hooksPath gdd/hooks
echo "installed: core.hooksPath -> gdd/hooks ($HOOK)"

# Verify the hook is active.
echo "verify: $(git -C "$REPO_ROOT" config core.hooksPath)"
[ -x "$HOOK" ] && echo "hook is executable: $HOOK"
