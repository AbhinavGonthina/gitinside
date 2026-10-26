# GitInside

**Git inside your repo.**

See how any codebase really works. Break it down from services to functions, trace every request, and catch broken connections before they ship.

(Status: in development)

## Results so far

Reported exactly as measured; each links to the committed report.

- **Analysis time (M1 baseline):** cal.com at a pinned SHA (5,041 files, 113 workspace packages) analyzes in a median of 53.3 s (range 27–77 s) with ~2 GiB peak memory on a dev laptop, and every run produces a byte-identical graph. [Report](bench/results/2026-10-26-analysis-calcom.md). Reproduce with `pnpm bench`.

## Contributing setup

After cloning, install the git hooks once:

```sh
sh scripts/setup-hooks.sh        # macOS / Linux / Git Bash
```

```powershell
.\scripts\setup-hooks.ps1        # Windows PowerShell
```
