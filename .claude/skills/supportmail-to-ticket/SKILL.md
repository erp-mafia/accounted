---
name: supportmail-to-ticket
description: "Triage Accounted customer support emails and turn them into GitHub issues in the erp-mafia/gnubok repo. Use this skill whenever the user invokes /supportmail-to-ticket (with or without a number argument), or asks to 'triage support mail', 'turn support emails into tickets', 'process Accounted support', 'check the support inbox and file issues', or any similar phrasing involving the Accounted support mailbox. Also trigger this skill if the user mentions [Accounted support] emails and wants them converted into actionable work, even if they don't use the exact slash command."
---

# supportmail-to-ticket

Triage `[Accounted support]` emails from Gmail, cross-reference them against the local erp-base codebase, and draft GitHub issues for the `erp-mafia/gnubok` repo, with inline user approval before anything gets created.

## Invocation

Primary form:

```
/supportmail-to-ticket [N]
```

- `N` = number of most recent `[Accounted support]` threads to triage. Optional. Default: `3`.
- Examples: `/supportmail-to-ticket`, `/supportmail-to-ticket 10`, `/supportmail-to-ticket 1`

If the user phrases the request in natural language ("triage the last 5 support mails", "check the inbox"), extract the number if present, otherwise use `3`.

## Required tools

Before running anything, verify these are available. If any is missing, stop and tell the user which one to configure. Do not attempt workarounds.

- **Gmail MCP**: `search_threads`, `get_thread`
- **GitHub CLI (`gh`)**: used via `bash_tool` for all GitHub operations. Verify with `gh --version` and `gh auth status`. If either fails, stop and say: *"I need the GitHub CLI (gh) installed and authenticated. Install from https://cli.github.com/ and run `gh auth login`, then retry. This skill uses gh as a hard requirement: there is no MCP fallback."* Do not proceed without it.
- **Filesystem MCP** pointing at `C:\Users\emilm\projects\erp-base`: the skill is explicitly designed around local code search. If the filesystem tool is not available or the path doesn't resolve, stop and say: *"I need the Filesystem MCP configured with access to `C:\Users\emilm\projects\erp-base`. Please set it up in Claude Desktop's MCP config and retry."* Do not fall back to remote code search: the user has asked for local-only.

## Workflow

Follow these five phases in order. Do not skip phase 4 (approval).

### Phase 1: Fetch emails

Call Gmail `search_threads` with:

- `query`: `subject:"[Accounted support]"`
- `pageSize`: the requested N (default 3)

For each returned thread, call `get_thread` with `messageFormat: FULL_CONTENT` to retrieve the full body. Extract per thread:

- `threadId`
- `subject`
- Date of the first message
- Full body text of the first message (this is the customer's actual complaint)
- Any reply messages (if the team has already responded, mention that but still propose a ticket unless the reply clearly resolves it)

**Do not extract, store, or display the customer's email address anywhere.** Tickets are fully anonymized: the sender address must never appear in chat output, issue bodies, or issue comments. Use the Gmail thread ID alone as the correlation identifier.

### Phase 2: Codebase analysis (local only)

For each email, analyze the complaint and search the local codebase at `C:\Users\emilm\projects\erp-base`.

**Step 2a: Extract search terms from the email.** From the customer's message, pull:

- Domain nouns (e.g., "SIE", "import", "bank", "fiscal year", "bokslut", "moms", "verifikat")
- Quoted error strings or UI labels
- Feature names the customer references

The emails are often in Swedish. Translate/expand Swedish terms to likely code identifiers (examples: `importera` → `import`, `räkenskapsår` → `fiscalYear`/`fiscal_year`, `bank` → `bank`, `SIE-fil` → `sie`/`SIE`, `verifikat` → `verification`/`voucher`, `moms` → `vat`/`tax`).

**Step 2b: Search.** Use the filesystem tool to run targeted searches. Prefer grep-style or directory reads over reading whole files. For each search term:

- Search filenames and paths first (fast, high signal)
- Then search file contents, case-insensitive
- Focus on `.ts`, `.tsx`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.kt`, whatever extensions actually exist in the repo (check with a directory listing first if unsure)
- Skip `node_modules`, `dist`, `build`, `.git`, `.next`, `target`

Collect up to ~5 most relevant file paths per email, with a line number or function name if you can identify one. Don't dump search results wholesale, synthesize.

**Step 2c: Severity heuristic.**

- **high**: core function broken (import fails completely, data loss risk, cannot log in, money/accounting math wrong, multiple users reporting same issue in this batch)
- **medium**: feature partially broken, workaround exists, affects one customer, UX friction in a common flow
- **low**: cosmetic, feature request, documentation gap, edge case
- **feature**: customer is asking for something that doesn't exist yet (use label `feature`, priority is less relevant)

### Phase 3: Draft tickets

For each email, produce one draft issue. Output format per ticket (inline in chat):

```
━━━ Ticket 1 of N ━━━
Title: <concise imperative title, ≤ 80 chars>
Labels: <from: bug, feature, report, improvement, error + priority label>
Priority: <high | medium | low>

Description:
<2-4 sentence summary of the customer's problem in your own words. State the observed behavior and expected behavior if you can infer it.>

Relevant code:
- path/to/file.ts:line: short note on why this is relevant
- path/to/other.ts: short note
(If nothing found locally, say "No direct match in codebase: investigation needed" and suggest where to start looking.)

Next steps:
- Concrete first thing a developer should do
- Second concrete step
- (2-4 steps total, specific not vague)

Customer email (anonymized):
<The full body of the customer's first message, with all personal names AND email addresses replaced by `x`. See the anonymization rules below.>

Gmail thread ID: <threadId>
```

**Anonymization rules, applied to the email body before it goes into the ticket**:

The goal: strip anything that identifies the **specific customer or their employer**. Keep everything else (competitor tools, banks, authorities, domain terms) because that's operational context the developer needs.

- **Replace personal first and last names with `x`**. Example: *"Hey this is amazing. My name is Emil and I do bla bla"* → *"Hey this is amazing. My name is x and I do bla bla"*. Handles greetings (*"Hej Anna,"* → *"Hej x,"*) and signatures (*"/Lars Andersson"* → *"/x"*).
- **Replace the customer's employer / own company name with `x`**, wherever it appears: body text, signatures, "jag jobbar på …", "vi på …", org numbers attributed to the sender, `@company.com` email domains. Also redact names of their direct clients or other companies they identify themselves through. Example: *"Jag jobbar på Capnos och behöver ta bort Capnos"* → *"Jag jobbar på x och behöver ta bort x"*.
- **Do NOT redact** (these are not identifying, they're context):
  - **Accounted itself**
  - **Swedish authorities / standard bodies**: Skatteverket, Bolagsverket, Försäkringskassan, Bankgirot, BFN
  - **Accounting / ERP providers and competitors**: Fortnox, Visma, Bokio, SpeedLedger, BL/Björn Lundén, Briox, etc.
  - **Banks by name**: Swedbank, SEB, Handelsbanken, Nordea, etc. (unless clearly the customer's *own* company, rare)
  - **File formats / protocols / standards**: SIE, K2, K3, BAS, PSD2, Peppol, BFNAR
  - **Generic domain terms**: moms, verifikat, räkenskapsår, etc.
- **Replace every email address with `x@x`**, including the sender's address, any `Från: <email>` or `From: <email>` header line inside the body, CC/BCC lines, and addresses mentioned in the body text. Do this before any other processing of the body.
- **Replace phone numbers with `x`** (Swedish and international formats).
- **Replace any internal identifier that ties the ticket to a specific account**: user UUIDs (e.g. `User ID: d36ff376-...`), session IDs, customer IDs. Replace the value with `x` but keep the label so the field structure is still readable.
- **Never include Gmail URLs** (`https://mail.google.com/mail/u/.../#inbox/<id>`) anywhere in the issue body. The Gmail thread ID alone, as a plain identifier, is the only correlation allowed: it shows up once at the bottom as `**Gmail thread ID:** \`<id>\``. No `Original support thread: <URL>` line.
- **Never output the customer's email address anywhere**: not in the chat preview, not in the GitHub issue body, not in issue comments, not in the summary.
- **Keep** product names we build around, domain terms, error messages, account numbers, SIE references, dates, and amounts.
- If unsure whether a capitalized word identifies the *customer or their employer* specifically, redact it. If it's clearly a third-party tool, bank, or authority, keep it. False positives on names/employers are harmless; leaked identifiers aren't.

**Priority label convention**: use `priority:high`, `priority:medium`, `priority:low`. If the repo already has `P0`/`P1`/`P2` labels (check in phase 4), prefer those instead.

**Duplicate check (before presenting)**: For each draft, run:

```bash
gh issue list --repo erp-mafia/gnubok --state open --limit 100 --json number,title,body,url
```

Parse the JSON output and scan titles + bodies for:

- The Gmail thread ID (exact match → definitely a duplicate)
- Overlapping key nouns from the title (likely duplicate → flag, don't auto-skip)

If a duplicate is found, replace that ticket block with:

```
━━━ Ticket N of M ━━━ [DUPLICATE]
Matches existing issue: #<number>, <existing title>
URL: <issue url>
Gmail thread ID: <threadId>
Suggested action: add a comment to the existing issue linking this new customer report.
```

Run the `gh issue list` call **once** at the start of phase 3 and reuse its results across all drafts: don't call it per ticket.

### Phase 4: Approval (inline, required)

After presenting all drafts, ask:

> Reply with your decisions per ticket. Examples:
> - `1 approve, 2 approve, 3 reject`
> - `all approve`
> - `1 approve but change title to "Fix bank import for Swedbank"`
> - `2 edit: change priority to high and add label "error"`
> - `3 comment on existing #42 instead of new issue`
>
> I'll wait for your reply before creating anything on GitHub.

Wait for the user's response. **Do not create issues until they reply.** If the user's reply is ambiguous, ask specifically rather than guessing.

Parse their response per ticket. Apply edits to the draft. If they reject a ticket, drop it silently. If they ask to comment on an existing issue instead of creating new, add that to the action list.

### Phase 5: Create on GitHub

For each approved ticket, use the `gh` CLI via `bash_tool`.

**Creating a new issue.** Write the body to a temp file first (avoids shell-escaping pain with multi-line content and special characters), then pass it via `--body-file`:

```bash
# Write the body to a temp file
cat > /tmp/issue-body-<N>.md <<'EOF'
<description paragraph>

## Relevant code
- path/to/file.ts:line: note
- path/to/other.ts: note

## Next steps
- Step 1
- Step 2
- Step 3

## Customer email (anonymized)

> <Full body of the customer's first message, wrapped as a blockquote, with all personal names AND email addresses replaced by `x` / `x@x` respectively.>

---
**Gmail thread ID:** `<threadId>`
EOF

# Create the issue
gh issue create \
  --repo erp-mafia/gnubok \
  --title "<approved title>" \
  --body-file /tmp/issue-body-<N>.md \
  --label "<label1>" --label "<label2>"
```

The command prints the new issue's URL on success: capture it for the summary. Use `--json number,url` + `gh issue create ... | cat` if you need to parse the result programmatically; otherwise the stdout URL is fine.

**Commenting on an existing issue** (for duplicates where the user chose "comment on existing"):

```bash
gh issue comment <issue-number> \
  --repo erp-mafia/gnubok \
  --body "Another customer report of this issue. Gmail thread ID: \`<threadId>\`."
```

**Label notes**:

- Available labels in this skill: `bug`, `feature`, `report`, `improvement`, `error`, plus priority (`priority:high`, `priority:medium`, `priority:low`).
- If `gh issue create` fails with an error mentioning an unknown label (exit code non-zero, stderr contains `"could not add label"` or `"not found"`), retry the command without that `--label` flag and tell the user which labels are missing so they can create them manually: do **not** attempt to create labels automatically.
- You can check available labels once at the start of phase 5 with: `gh label list --repo erp-mafia/gnubok --limit 100 --json name`, useful if multiple label errors happen in a row.

**Project board**: Issues are created in the `erp-mafia/gnubok` repo. The Accounted project board (`erp-mafia/projects/...`) aggregates issues but adding to a project via `gh` requires `gh project item-add` with the project number and GraphQL scopes that may not be in the current auth token. After creating issues, output the project URL once and remind the user they may want to drag the new issues onto the board. Example wording: *"Issues created. If you want them on the Accounted project board, you'll need to add them manually at https://github.com/orgs/erp-mafia/projects, or run `gh project item-add` if you have project scopes on your token."*

### Phase 6: Summary

End with a compact summary:

```
Created 2 issues:
- #47 Fix SIE import failure for first fiscal year: https://github.com/erp-mafia/gnubok/issues/47
- #48 Investigate bank import for banks without BankID: https://github.com/erp-mafia/gnubok/issues/48

Commented on 1 existing:
- #42: added new customer report

Skipped: 0
```

## Error handling

- **No emails found**: say so, don't invent any.
- **Gmail thread fetch fails for one email**: skip that one, report which, continue with the rest.
- **Filesystem MCP not configured / path not found**: stop entirely, instruct the user to set it up. Do not proceed with remote-only search.
- **`gh` not installed or not authenticated**: stop entirely at the pre-check. Do not proceed.
- **`gh issue list` fails during duplicate check**: proceed without duplicate detection and warn the user in the summary.
- **`gh issue create` fails for one ticket**: report which ticket failed, include the `gh` stderr, continue with the remaining approved ones.
- **`gh` rate-limited** (HTTP 403 with "rate limit"): stop, tell the user to wait or check `gh api rate_limit`. Don't retry in a loop.

## Style notes for generated tickets

- Titles are imperative ("Fix X", "Investigate Y", "Add Z"), not declarative ("X is broken").
- Titles ≤ 80 characters. No emoji. No brackets.
- Descriptions are ≤ 4 sentences. Describe what the customer sees and what should happen instead.
- Next steps are concrete: "Check `importSie()` for silent catch blocks on line 142", not "Investigate the import code".
- Paste the customer's email body verbatim into the `Customer email (anonymized)` section, with personal names replaced by `x`. No Gmail link: the ticket should be self-contained.
- If the email is in Swedish, the summary/description/next steps are in English, but the anonymized email body stays in its original language. Keep domain terms that match the code (`SIE`, `verifikat` if the code uses that spelling, etc.).
