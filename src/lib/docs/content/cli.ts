/**
 * The `accounted` command-line client (packages/accounted-cli).
 *
 * The Swedish version lives in lib/docs/content/kommandorad.ts. The docs site
 * has no locale routing, so the two languages live at two URLs and cross-link
 * to each other. Keep them in sync: an edit to one is only half an edit.
 */
export const CLI_MD = `# Command line (CLI)

> Run Accounted from a terminal. The \`accounted\` command reaches the same tools as the Claude and ChatGPT connectors, with the same permissions and the same approvals: nothing is booked until you approve it.

_Den här sidan på svenska: [Kommandoraden](/docs/api/kommandorad)._

\`accounted\` is a small command-line client for the Accounted [MCP](https://modelcontextprotocol.io) server. It is made for developers, scripts and AI agents that work in a shell: Claude Code, Codex, Cursor, or anything else that can run a command. Every tool on the server is one \`accounted call\` away, including the specialised ones a chat client only finds by searching, and the answer comes back as JSON.

Working in claude.ai, Claude Desktop or ChatGPT instead? Add a connector: see [Connect with Claude](/docs/api/connect-claude).

## Install

\`\`\`bash
npm install -g accounted
accounted --version
\`\`\`

Requires Node.js 20 or later. \`npx accounted\` also works without installing, but every call then starts slowly, so install it when an agent will make many calls.

## Sign in

\`\`\`bash
accounted login
\`\`\`

The browser opens the Accounted sign-in; the address is printed in the terminal too, in case no browser opens. Sign in with BankID or e-mail, and the consent page follows. It is the same page the Claude and ChatGPT connectors show: every permission is pre-selected, and you can untick rows under **Behörigheter** or choose **Endast läs** for read-only access. With several companies you also choose, per company, **Läsa och skriva**, **Bara läsa** or **Ingen åtkomst**. Approve, and the terminal says \`Signed in\`.

**Sign in yourself, in your own terminal.** An agent should never sign in for you. In Claude Code you can type \`! accounted login\` at the prompt when the browser runs on the same computer.

Over SSH or in a container, the browser cannot reach the machine the command runs on. Open the printed address in any browser and approve; the browser then ends on a page that cannot load. Copy that page's whole address, paste it into the terminal and press Enter. \`accounted login --no-browser\` skips the browser and goes straight to pasting. The sign-in waits 5 minutes.

The sign-in is saved in \`~/.config/accounted/credentials.json\` (under \`$XDG_CONFIG_HOME\` when that is set, in \`%APPDATA%\\accounted\` on Windows), readable only by your user. It shows up as a connection under **Settings › API & MCP** (\`/settings/api\`).

- \`accounted status\` shows the server, the sign-in and the companies it reaches. It exits with 3 when you are not signed in.
- \`accounted logout\` removes the sign-in from this computer only. The key keeps working until you disconnect it in Settings › API & MCP; logout prints the key prefix to look for there.
- \`accounted login --force\` replaces the sign-in, for example to grant other permissions. Disconnect the old key in Settings afterwards.

## Find and run tools

- \`accounted guide\` explains how to work with Accounted: workflows, approvals and companies.
- \`accounted tools\` lists the common tools, and \`accounted tools supplier invoice\` searches all of them.
- \`accounted describe create_customer\` shows a tool's definition and input schema.
- \`accounted call list_invoices '{"limit": 5}'\` runs a tool.

A tool name works with or without the \`accounted_\` prefix and with \`-\` or \`_\`: \`list-invoices\`, \`list_invoices\` and \`accounted_list_invoices\` are the same tool. \`accounted call\` reaches every tool, also those only found by search. When a search result or the guide mentions \`callable_via\`, \`call_tool\` or \`stage_tool\`, ignore it: those bridges are for chat clients that cannot call an unlisted tool, and the CLI does not need them. Signed out, a search covers only the tools that work without an account; signed in, it covers all of them.

Arguments are one JSON object, inline, from a file, or from stdin with \`-\`:

\`\`\`bash
accounted call get_general_ledger '{"account_from": "1930", "account_to": "1930"}'
accounted call create_customer '@customer.json'
accounted call create_customer - <<'EOF'
{"name": "Exempel AB", "customer_type": "swedish_business", "email": "billing@example.com"}
EOF
\`\`\`

There are no \`--flag\` arguments on purpose: guessing types on the command line would turn the account number \`"1930"\` into a number. Account numbers are strings, amounts are in SEK, and dates are written \`YYYY-MM-DD\`. \`accounted describe\` shows exactly what a tool takes.

The result goes to stdout as JSON: indented in a terminal, one line in a pipe, so it combines with tools like \`jq\`. Notes for you or your agent (which company answered, what to do next) go to stderr. A tool error prints \`{"error": {...}}\` on stderr and exits with 1.

## Writes wait for your approval

Writes work exactly as over MCP. A tool that changes the books (categorise, create an invoice, book a voucher, close a period) changes nothing yet: it stages a pending operation with a preview of what would be booked, and the CLI prints how to approve it:

\`\`\`text
Staged for approval: operation 9a44..., risk medium. Nothing is booked yet.
When the user approves it, run: accounted call approve_pending_operation '{"operation_id":"9a44...","company_id":"..."}'
Or approve it in the browser: https://app.accounted.se/pending
\`\`\`

Read the preview, then approve with that command or under **/pending** in the app. An agent must show you the preview and ask you before it runs the approve command.

High-risk operations (for example manual vouchers, corrections, period locks and year-end) are irreversible once approved (BFL 5 kap 5 §). For those the printed command leaves out \`"confirmed": true\` on purpose, and the CLI says so: the agent shows you the preview, gets your explicit acknowledgment, and only then adds \`"confirmed": true\` to the approve arguments.

If the sign-in lacks the permission to approve, approve under **/pending** instead.

## Long-running calls

A few tools, such as \`audit_package\`, take longer than a shell call should wait. They run as a task on the server: the CLI prints the task id and waits for the result. If the command is interrupted (a timeout in your agent, a closed terminal), pick it up again with:

\`\`\`bash
accounted task <id>
\`\`\`

Tasks are kept for one hour.

## Companies

One sign-in reaches every company you gave it access to. \`accounted status\` lists them with their ids. A call that names no \`company_id\` runs against the default company, and when the sign-in reaches several companies a note on stderr says which one answered.

To keep every call in one company, pin it with \`--company\` or \`ACCOUNTED_COMPANY\`:

\`\`\`bash
accounted call list_invoices --company <company-id>
export ACCOUNTED_COMPANY=<company-id>
\`\`\`

The value must be the company's id (a UUID). A name or a mistyped id is refused rather than falling back to every company, and while the pin is set, a call that names another company is refused.

## Scripts and exit codes

Every command ends with an exit code a script can test:

- \`0\`: done.
- \`1\`: the tool answered with an error (\`{"error": {...}}\` on stderr).
- \`2\`: usage: an unknown command or tool, or arguments that are not a JSON object.
- \`3\`: not signed in, or the sign-in has ended.
- \`4\`: server or network trouble, including rate limiting (\`retry after N s\`).

\`\`\`bash
accounted status > /dev/null || exit $?
accounted call list_invoices '{"status": "overdue"}' | jq -r '.invoices[].invoice_number'
\`\`\`

A key may make 100 calls a minute by default. At the limit the CLI exits with 4 and says how long to wait: wait that long instead of retrying in a loop.

## API keys for CI and servers

Where nobody can open a browser, use an API key instead of a sign-in. Create one under **Settings › API & MCP** (\`/settings/api\`), keep it in your CI's secret store, and set it as \`ACCOUNTED_API_KEY\`:

\`\`\`bash
export ACCOUNTED_API_KEY=gnubok_sk_...
accounted call get_trial_balance > trial-balance.json
\`\`\`

The key's permissions decide which tools work, and nothing is saved on disk. When the variable is set, it wins over a saved sign-in. A test key (\`gnubok_sk_test_...\`) reads your real data, but its writes only run as dry runs, and a write that cannot be simulated is refused, so it is safe to experiment with.

## Your own server

Running Accounted yourself? Point the CLI at your server with \`--url\` or \`ACCOUNTED_URL\`. Both take the app address or the full MCP URL, the same variable the \`accounted-mcp\` bridge uses. Each server keeps its own sign-in.

## Windows

In PowerShell, pass JSON from a file. Inline JSON can lose its quotes on the way to the command, and in Windows PowerShell 5.1, JSON piped into \`-\` turns å, ä and ö into \`?\`. Save the JSON as UTF-8 and quote the file argument, since \`@\` means something else to PowerShell:

\`\`\`powershell
accounted call create_customer '@customer.json'
\`\`\`

## Troubleshooting

- **Exit 3, "Not signed in".** Run \`accounted login\` in your own terminal.
- **An agent in a sandbox gets exit 3.** A sandboxed agent can neither save a sign-in nor renew one ("Cannot save the sign-in", "cannot be written here"). Run \`accounted login\`, or \`accounted status\` (which renews a sign-in that needs it), in your own terminal, then let the agent continue.
- **"Already signed in".** Run \`accounted login --force\` to replace the sign-in, or \`accounted logout\` first.
- **"The sign-in has ended".** The connection was disconnected in Settings or is no longer valid. Run \`accounted login\` again.
- **Exit 4, "Rate limited".** Wait the number of seconds shown, then continue.
- **"The server redirected to ...".** Pass that address with \`--url\`.
- **Behind a proxy.** \`HTTPS_PROXY\` and other proxy settings are not supported in version 0.1: the CLI connects directly to the server.

Still stuck? Use the support form in the app under **/help**, and include the command, the exit code and the error text.
`
