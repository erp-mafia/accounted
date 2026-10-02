---
name: accounted-cli
description: Work in a person's Accounted books (Swedish double-entry bookkeeping) from a shell with the `accounted` command. Use when an agent that can run commands (Claude Code, Codex, Cursor, a script) should read or change Accounted data such as invoices, bank transactions, receipts, reports, VAT, payroll or year-end. Covers the sign-in check, finding tools, JSON arguments, staged writes and approvals, companies, and exit codes.
---

# Accounted from the command line

`accounted` is a command-line client for the Accounted MCP server: the same tools, the same permissions and the same approval rules as the Claude and ChatGPT connectors. Every write is staged; nothing is booked until the person approves it. Docs: https://app.accounted.se/docs/api/cli

## Before the first call

1. `accounted --version`. If the command is missing, ask the person to run `npm install -g accounted` (Node.js 20 or later). Avoid `npx accounted`: it starts slowly on every call.
2. `accounted status`. It prints the server, the sign-in and the companies it reaches.
   - Exit 3 means not signed in, or a sign-in this environment cannot save or renew. Ask the person to sign in themselves: they run `accounted login` in their own terminal (in Claude Code, `! accounted login` works when the browser runs on the same computer). Then run `accounted status` again.
   - Never run `accounted login` yourself from a sandbox and never try to sign in on the person's behalf. If a message says the sign-in needs renewing, ask the person to run `accounted status` once in their own terminal.
3. `accounted guide`, once per session. It is the guidance an MCP client gets on connect: workflows, approval rules, companies. Follow it.

## Finding the right tool

- `accounted tools` lists the common tools; `accounted tools <words>` searches all of them, for example `accounted tools supplier invoice`. Signed out, search covers only the tools that work without an account.
- `accounted describe <tool>` prints the definition and input schema. Read it before the first call to a tool; never guess argument names.
- Names work with or without the `accounted_` prefix and with `-` or `_`.
- `accounted call` reaches every tool directly, including search-only ones. Ignore `callable_via`, `call_tool` and `stage_tool` in search results and in the guide: those bridges exist for chat clients, not for the CLI.

## Calling a tool

Arguments are one JSON object. Short ones can go inline in single quotes; for anything with quotes, å/ä/ö or more than a few fields, use a heredoc on stdin with `-`, or a file with `'@file.json'`:

```bash
accounted call get_general_ledger '{"account_from": "1930", "account_to": "1930"}'

accounted call create_customer - <<'EOF'
{"name": "Exempel AB", "customer_type": "swedish_business"}
EOF
```

- Account numbers are strings: `"1930"`, never `1930`.
- Amounts are in kronor (SEK) unless the tool takes a currency. Dates are `YYYY-MM-DD`.
- The result is JSON on stdout (one line when piped); notes go to stderr. When the sign-in reaches several companies, a stderr note names the company that answered: check it before you act on the data.
- Never invent account numbers, VAT treatments or amounts. Read them from the books or the documents, or ask.

## Writes: stage, show, ask, approve

A tool that changes the books stages a pending operation instead of booking. The result has `staged: true`, an `operation_id`, a `risk_level`, a `preview` of what would be booked, and a `message` that may carry a WARNING. On stderr the CLI prints the exact approve command and the `/pending` link.

1. Show the person the preview in plain words: what will be booked, on which accounts, the amounts and dates, and every warning.
2. Ask. Run the printed `accounted call approve_pending_operation '{...}'` only after the person has said yes to that operation in this conversation.
3. High risk (`risk_level: "high"`, for example manual vouchers, corrections, period locks, year-end): the posting is irreversible once approved (BFL 5 kap 5 §). The printed command leaves out `"confirmed": true` on purpose, and the CLI says so. Tell the person it cannot be undone, get an explicit acknowledgment, and only then add `"confirmed": true` to the approve arguments.
4. Never approve in a loop, in bulk, or "the rest too" without the person's explicit go for exactly that set. A yes covers what you showed, nothing more.
5. If approving fails because the sign-in lacks the permission to approve, tell the person to approve under `/pending` in the app.

`accounted call list_pending_operations` shows what is waiting. To drop one the person does not want: `accounted call reject_pending_operation '{"operation_id": "..."}'`.

## Companies

- `accounted status` lists the companies with their ids. A call without `company_id` runs against the default company.
- To keep a session in one company, add `--company <id>` to each command or set `ACCOUNTED_COMPANY=<id>`. The value must be a company id (a UUID); a name is refused. While pinned, a call naming another company is refused.
- When you work across companies, say which company each answer came from.

## Long-running calls

Some tools (for example `audit_package`) run as a task on the server. The CLI prints the task id and waits. If your shell call times out, run `accounted task <id>` to keep waiting; tasks are kept for one hour. Do not call the tool again: that starts a second run.

## Exit codes

- `0`: ok.
- `1`: the tool returned an error, printed as `{"error": {...}}` on stderr. Read it and change the arguments or the approach; do not repeat the same call unchanged.
- `2`: usage: unknown command or tool, or arguments that are not a JSON object. Check `accounted describe <tool>`.
- `3`: not signed in, or the sign-in has ended. Ask the person to sign in (see above); do not retry.
- `4`: server or network. When stderr says `Rate limited by the server: retry after N s`, wait N seconds before the next call.

A key allows 100 calls a minute by default, shared by everything that uses the same sign-in. Prefer one list call with a higher `limit` over many single reads, and never hammer the server after a 4.

## Do not

- Read, edit or delete the credentials file, or print a key.
- Set `ACCOUNTED_API_KEY` unless the person gave you a key for that purpose.
- Approve, reject or book anything the person has not seen and agreed to.
