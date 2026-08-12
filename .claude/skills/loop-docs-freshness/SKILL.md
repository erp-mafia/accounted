---
name: loop-docs-freshness
description: Weekly loop that checks the public API docs (docs.accounted.se) against what this repo generates today, files one deduped drift issue, and proposes the re-export PR in the gnubok-website repo. Use on a weekly cadence or on-demand via /loop-docs-freshness. Follows .claude/loops.md (propose-don't-merge).
---

# loop-docs-freshness

**Goal:** what docs.accounted.se serves is byte-identical to what this repo would generate today.
The docs site lives in the separate `jakobwennberg/gnubok-website` repo and is fed by manual
snapshot exports, so it silently drifts whenever an endpoint, error code, or content page changes
here. **Never merge.** Read `.claude/loops.md` first.

## Preflight

`gh auth status`, repo `erp-mafia/accounted`. If it fails, stop and report "environment not provisioned".

## 1. Due check (weekly semantics)

Find the most recent trace: `gh issue list --label loop:docs --state all --limit 5 --json number,title,updatedAt`
plus the newest `<!-- loop-docs-freshness-run: YYYY-MM-DD -->` marker in those issues' comments.
If a run marker is dated **less than 6 days ago**, report "not due" and stop, unless the user
invoked `/loop-docs-freshness` explicitly (explicit invocation always runs).

## 2. Run the deterministic check

From an up-to-date `main` checkout (the comparison is "what main generates" vs "what the site
serves"; a feature branch would produce false drift):

```bash
npx tsx scripts/check-docs-freshness.mts
```

- **Exit 0** (in sync): if an open `loop:docs` drift issue exists, comment that the site is back
  in sync and close it. Post the run marker (step 5). Done.
- **Exit 2** (fetch/build failure): the site is unreachable or the content modules changed shape.
  Do NOT file a drift issue. If this is the second consecutive exit-2 run, file/update one issue
  labeled `loop:auto`, `loop:docs`, `loop:needs-human` describing the failure. Stop.
- **Exit 1** (drift/missing): continue.

## 3. File or update ONE drift issue (cap: 1 per run)

The script prints a `FINGERPRINT` per drifted page. Compute the run fingerprint = first 12 hex
chars of sha256 over the sorted page fingerprints, then dedupe per `.claude/loops.md`:

- `gh issue list --search "<run-fingerprint> in:body" --state all` : match open → comment the fresh
  script summary instead of filing; match closed → reopen with a note.
- Otherwise file **one** issue (never one per page):
  - Title: `docs drift: docs.accounted.se out of sync (<N> pages)`
  - Body: the script's non-ok output verbatim, the remediation steps below, and
    `<!-- loop-fingerprint: <run-fingerprint> -->`.
  - Labels: `loop:auto`, `loop:docs`, `documentation`.

If an *older* open `loop:docs` issue has a different fingerprint (the drift changed), comment on
it with a pointer to the new issue and close it: one open drift issue at a time.

## 4. Propose the fix (cap: 1 website PR per run)

Two failure classes, two remedies:

- **Generated snapshots stale** (`reference*`, `errors.md`, `connect-claude.md`): run
  `npx tsx scripts/export-docs-to-website.mts`. It writes `*.generated.ts` into
  `~/gnubok-website`.
- **Hand-copied pages stale** (`changelog.md`, `versioning.md`, `webhooks.md`, `cookbook/*`):
  copy the exported markdown constants from `lib/docs/content/` in erp-base over the website
  repo's duplicates in `lib/docs/content/`. Mechanical copy only; if the two sides have diverged
  in structure (not just content), escalate with `loop:needs-human` instead.

The `~/gnubok-website` checkout is often on a human's WIP branch. **Never commit on it.** Work in
a fresh worktree from origin/main:

```bash
git -C ~/gnubok-website fetch origin
git -C ~/gnubok-website worktree add /tmp/loop-docs-freshness-wt -b loop/docs-freshness-<run-fingerprint> origin/main
```

Re-run the export/copy against the worktree, commit, push, and open a PR **in
`jakobwennberg/gnubok-website`** whose body links the erp-base drift issue and embeds the same
fingerprint marker. Then remove the worktree. Never merge; the founder deploys the website.

**404s on pages whose routes exist on the website's origin/main** (seen 2026-08-09 for every
`reference/<slug>.md` and `cookbook/<slug>.md` mirror) are a deploy/runtime problem, not a
snapshot problem: a re-export PR will not fix them. Label the issue `loop:needs-human` and say
so explicitly.

## 5. Run marker + report

Comment `<!-- loop-docs-freshness-run: YYYY-MM-DD -->` plus a one-line summary on the drift issue
touched this run (or, when in sync and nothing is open, skip the marker comment and rely on the
closed issue's timestamp). Summarize: pages in sync / drifted / missing, issue filed or updated,
website PR opened, escalations. That summary is the completion notification.

## Anti-thrash

If a previous run already opened a website PR for the **same run fingerprint** and it is still
open, do not open another: comment on the existing PR/issue instead. If the same fingerprint
drifts again after its PR merged and deployed, something upstream regenerates differently:
`loop:needs-human`.
