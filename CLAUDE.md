# CLAUDE.md

Planning context lives in the private repo `gitinside-planning`, cloned next to this repo (`../gitinside-planning`). If it's missing, run `gh repo clone AbhinavGonthina/gitinside-planning ../gitinside-planning`.

At the start of every session:

1. `git pull` in both repos.
2. Read `../gitinside-planning/SPEC.md` and the latest entry in `../gitinside-planning/SESSION_LOG.md`.
3. Check what's waiting on Abhinav: `gh issue list --repo AbhinavGonthina/gitinside-planning --label needs-abhinav --state all`. A closed issue means he resolved it; the closing comment has details. Remove it from **Needs Abhinav** in `PROGRESS.md`.

When something needs Abhinav personally (credentials, API keys, paid signups, domain purchase, GitHub App registration, a SPEC conflict, or setting `STATUS: BLOCKED`), open an issue so he gets notified:

```sh
gh issue create --repo AbhinavGonthina/gitinside-planning --label needs-abhinav \
  --title "<what's needed, in a few words>" --body "<why, what it blocks, exactly what he should do>"
```

Use the private planning repo, never the public `gitinside` repo. Never put secret values in issues. Search open `needs-abhinav` issues first so you don't open duplicates.

Commits: no AI attribution (no `Co-Authored-By: Claude`, no "Generated with Claude Code"). Hooks: `sh scripts/setup-hooks.sh` or `.\scripts\setup-hooks.ps1`.
