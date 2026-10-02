# accounted

Command-line client for [Accounted](https://accounted.se), Swedish double-entry bookkeeping. It runs every Accounted tool from a terminal, a script, or a coding agent's shell (Claude Code, Codex, Cursor).

It is a thin client over the same hosted endpoint as the Accounted MCP connector: the same tools, the same permissions, and the same approval step. Writes are staged; nothing is booked until the user approves.

## Install

```sh
npm install -g accounted
```

Needs Node.js 20 or later. `npx accounted ...` also works, but starts slower on every call.

## Sign in

```sh
accounted login
```

The browser opens the Accounted consent page, the same one the Claude and ChatGPT connectors use. Every permission your role allows is ticked; untick what you do not want, or choose read only. With several companies you choose the access per company.

If the browser cannot reach this machine (SSH, a container, an agent's sandbox), or with `--no-browser`, the browser ends on a page that cannot load: copy that page's whole address and paste it into the terminal.

Run `accounted login` yourself, in your own terminal. In Claude Code: `! accounted login`.

The sign-in is saved in `~/.config/accounted/credentials.json` (`$XDG_CONFIG_HOME`, or `%APPDATA%\accounted` on Windows), readable only by you. `accounted logout` removes it from this computer; the key keeps working until you disconnect it under Settings › API & MCP, and logout prints which key to look for.

For CI and servers, set `ACCOUNTED_API_KEY` to an API key from Settings instead of logging in.

## Use

```sh
accounted status                              # server, sign-in, companies
accounted guide                               # how to work with Accounted
accounted tools faktura                       # search every tool
accounted describe list_invoices              # one tool's input schema
accounted call list_invoices '{"limit": 5}'   # run a tool
```

Tool names work with or without the `accounted_` prefix, with `-` or `_`.

Arguments are one JSON object: inline, from a file with `'@args.json'`, or from standard input with `-`:

```sh
accounted call create_customer - <<'EOF'
{"name": "Åkeri AB", "customer_type": "swedish_business", "org_number": "5560000000"}
EOF
```

There are no `--flag` arguments for tool inputs on purpose: account numbers such as `"1930"` are strings, and guessing types would break them.

The result is JSON on stdout (indented in a terminal, one line in a pipe). Notes go to stderr.

### Writes and approval

A write stages a pending operation and shows a preview. The CLI then prints the exact command that approves it, and the link to approve it in the browser (`/pending`). Approve only when the user says so. A high-risk operation (a voucher, a correction, a year-end close) is irreversible once approved: show the user the preview, get an explicit acknowledgment, and only then add `"confirmed": true` to the approve arguments.

### Companies

`--company <id>` or `ACCOUNTED_COMPANY=<id>` pins every call to one company. Find the ids with `accounted call list_companies`. A value that is not a company id is refused.

### Long calls

A long call (the audit package) runs as a task on the server. The CLI prints the task id and waits; if it is interrupted, `accounted task <id>` picks it up again. Tasks are kept for an hour.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK, including a staged write |
| 1 | The tool answered with an error (`{"error": ...}` on stderr) |
| 2 | Usage: bad command, arguments, tool name or company id |
| 3 | Not signed in, or the sign-in has ended: run `accounted login` |
| 4 | Server or network problem, or the rate limit (by default 100 calls a minute per key) |

## Other servers

`--url` or `ACCOUNTED_URL` takes the app address (`https://books.example.se`) or the full MCP URL, the same variable the `accounted-mcp` bridge uses. Self-hosted installations work the same way.

## Limits in 0.1

- No proxy support (`HTTPS_PROXY` is ignored).
- Windows PowerShell 5.1 can strip the quotes inside an argument and turns å, ä and ö into `?` when piping. Put the JSON in a UTF-8 file and pass `'@args.json'` (quoted, or PowerShell reads `@` as splatting).

## Releasing

Published to npm by the `Publish packages to npm` workflow (`.github/workflows/npm-publish.yml`), never by hand. Bump the version in both `package.json` and `lib/version.mjs` (a test checks that they match; the server logs the version as part of the client name), then merge to `main`: the workflow publishes any version that is not on npm yet, with provenance. The `NPM_TOKEN` secret needs write access to `accounted` (see Releasing in `packages/accounted-mcp/README.md`).

## License

MIT
