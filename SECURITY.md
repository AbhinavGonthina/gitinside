# Security policy

GitInside reads code that anyone can submit, and holds private repos' diagrams for the people who install its GitHub App. If you find a way around either, please tell me privately. The threat model, with the test behind each control, is [docs/SECURITY.md](docs/SECURITY.md).

## Supported versions

Only what's live: the hosted site at [gitinside.abhinavgonthina.dev](https://gitinside.abhinavgonthina.dev), its GitHub App and PR bot, and the `main` branch (the CLI and self-hosting run from it). There are no releases to backport fixes to.

## In scope

- **Running code from an analyzed repo.** GitInside parses repos and never installs, builds, or runs them: a repo that gets code to run in the analysis, or reads the worker's secrets or network, is a vulnerability. This covers the hosted worker and the `gitinside analyze` CLI.
- **Escaping the download.** A tarball that writes outside its job folder (paths, links), or a repo that gets past the size, file, memory, or time limits.
- **Seeing a private repo you can't see on GitHub.** Its diagram, code previews, analysis progress, pull request diffs, or README image, or data kept after the App is uninstalled or a repo removed from it.
- **Secrets in diagrams.** A value from a `.env` file, or a credential in a URL, showing up in a graph, image, or PR comment.
- **Script or markup from a repo running on the site** or rendering in a PR comment (file names, labels, code previews).
- **Forged requests:** webhooks, jobs, installation token requests, sign-in (login CSRF, open redirects), or session theft.
- **The GitHub App doing more than it should** with the permissions it's granted.

## Out of scope

- Load or denial-of-service testing, and anything that runs many analyses: the site runs on free plans, and its limits are listed at [/limits](https://gitinside.abhinavgonthina.dev/limits). Describe a cost or exhaustion problem instead of demonstrating it.
- The hosts themselves (GitHub, Vercel, Google Cloud, Neon, Oracle, Cloudflare). Report those to them.
- Vulnerabilities in the repos GitInside analyzes. Report those to their owners.
- Wrong or missing diagram edges. Those are bugs; open an [issue](https://github.com/AbhinavGonthina/gitinside/issues).
- Findings that need an already compromised account or device, social engineering, missing headers or cookie flags without a way to use them, and the setup of someone else's self-hosted copy.

When testing, use your own repos and your own App installation. If you reach anyone else's data, stop, keep none of it, and say so in your report.

## How to report

Use GitHub's private vulnerability reporting: [report a vulnerability](https://github.com/AbhinavGonthina/gitinside/security/advisories/new) (also the **Report a vulnerability** button on the repo's **Security** tab). Only you and the maintainer see the report.

Please don't open a public issue, pull request, or discussion with the details. If the form isn't available, open an issue asking for a private contact, with no details in it.

A useful report says:

- what an attacker can do, and to whom;
- the steps, or a repo or request that shows it (a minimal repo is best);
- where it applies: the hosted site, the CLI, or a self-hosted copy, and the commit if you know it.

## What happens next

GitInside is maintained by one person, so these are best efforts:

1. I acknowledge the report within 7 days.
2. I confirm it (or explain why not) and keep you posted in the advisory's thread, which is where we talk.
3. The fix lands on `main` with a test that fails without it, and the hosted site is redeployed. Data a bug exposed or kept is deleted.
4. Once the fix is live, the advisory is published, crediting you unless you'd rather not be named. Please wait for that before disclosing; if the fix is taking long, we can agree on a date.

There is no bug bounty: GitInside has no budget.
