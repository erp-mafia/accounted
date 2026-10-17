# Loops

Four skills that scan a source and then propose: they file or update GitLab issues
and open merge requests, and never merge. Run one by hand (`/loop-docs-freshness`)
or wrap it in `/loop <interval>` for a session. The weekly and monthly ones check a
run marker in their tracking issue first, so running them early is a cheap no-op.

| Skill | Watches | Cadence | Output |
|---|---|---|---|
| `loop-feedback-triage` | MCP agent feedback in prod `event_log` (30-day TTL, so run it at least monthly) | weekly | digest in `dev_docs/`, small fix MRs |
| `loop-docs-freshness` | docs.accounted.se against what the repo generates | weekly | one drift issue, website MR |
| `loop-regeluppdat` | Swedish laws and rules that affect the product | monthly | issues only, never code |
| `loop-skill-review` | community skill submissions | on demand | registry MR |

## Shared rules

- Propose, never merge. Work on a `loop/<loop>-<ref>` branch, never on `main` or
  someone else's branch, and never act on MRs from `contributor:flagged` or
  `pr:flagged` authors.
- A code change passes the Definition of Done checks in `CLAUDE.md` before its MR
  opens. Anything touching posted entries, money math, migrations or tax law becomes
  an issue labelled `loop:needs-human`, not an MR.
- Dedupe before filing: compute a stable fingerprint (error signature, file:line or
  rule id, never a timestamp), search every issue including closed ones
  (`glab issue list -R arcim-technology-ab-group1/accounted --all --in description --search "<fingerprint>"`),
  comment or reopen instead of duplicating, and embed
  `<!-- loop-fingerprint: <hash> -->` in the body.
- Label what a loop creates `loop:auto` plus its own label (`loop:docs`,
  `loop:regeluppdat`). If the same fix already failed once, stop and label it
  `loop:needs-human` with what was tried.
- Each run caps what it files or fixes and says what it skipped.
