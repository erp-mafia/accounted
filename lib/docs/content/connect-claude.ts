export const CONNECT_CLAUDE_MD = `# Connect with Claude

> Talk to your bookkeeping. Connect Accounted to Claude (claude.ai, Claude Desktop, or Claude Code) and ask questions, categorise transactions, and prepare a momsdeklaration in plain language: every write still stages for your approval first.

_Den här sidan på svenska: [Anslut Claude](/docs/api/anslut-claude)._

Accounted ships an [MCP](https://modelcontextprotocol.io) server that exposes the full bookkeeping engine (150+ tools) to any MCP client. The endpoint is:

\`\`\`
https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted
\`\`\`

There are three ways to connect, depending on your client. All three reach the same tools and the same approval model: read tools answer immediately, write tools (categorise, mark paid, create voucher, year-end) **stage a pending operation** that you confirm in chat or in the **/pending** web UI before anything is booked.

## Path A: claude.ai or Claude Desktop (one click)

**[→ Connect Accounted to Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Accounted&connectorUrl=https%3A%2F%2Fapp.accounted.se%2Fapi%2Fextensions%2Fext%2Fmcp-server%2Fmcp%3Ftool_namespace%3Daccounted%26client%3Dclaude-connector)**

The link opens claude.ai with the connector name and URL already filled in. You review the values and confirm; the link only prefills the dialog, it grants nothing on its own. No API key to manage.

**You do not need an Accounted account yet.** The connector works as soon as it is added: the server answers the handshake and the documentation tools without credentials, and the first company-scoped call opens the Accounted sign-in, where a new user creates the account (BankID or e-mail + 2FA).

**Read-only by default.** On the consent screen you pick the company and grant read scopes (list invoices, read reports, compute VAT). Write scopes (create invoice, categorise, book vouchers, run year-end) are listed separately and must be ticked explicitly, so a reviewer can connect read-only while you keep a write-enabled connection for daily work.

#### Adding it by hand instead

In **claude.ai** (Settings → Connectors) or **Claude Desktop** (Settings → Connectors → Add custom connector), choose **Add custom connector** and paste:

\`\`\`
https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=claude-connector
\`\`\`

Keep \`tool_namespace=accounted\`: it selects the tool names this guide uses. \`client=claude-connector\` is telemetry-only. If the dialog asks about authentication, choose **"Required when the server asks"**, not the auto-detected "None".

## Path B: Claude Code (plugin)

Best in the terminal. The plugin installs the connection *and* seven workflow commands that follow the Swedish bookkeeping rhythm.

\`\`\`text
/plugin marketplace add erp-mafia/accounted
/plugin install accounted@accounted
\`\`\`

Then run \`/mcp\` and sign in with Accounted (the same OAuth consent screen as Path A). Start with \`/accounted:start\`.

| Command | What it does |
|---|---|
| \`/accounted:start\` | Connect, orient, and surface what needs attention |
| \`/accounted:bookkeep\` | Clear unbooked bank transactions and receipts |
| \`/accounted:check\` | Read-only health check with a prioritized fix list |
| \`/accounted:month-close\` | Close the month against the product's checklist |
| \`/accounted:vat\` | Prepare and reconcile the momsdeklaration |
| \`/accounted:payroll\` | Monthly salary run and AGI underlag |
| \`/accounted:year-end\` | Bokslut, readiness-gated |

Prefer plain MCP without the workflow commands? \`claude mcp add\` wires the same connection into Claude Code:

\`\`\`bash
claude mcp add accounted --transport http \\
  "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=claude-code"
\`\`\`

**Cursor** has no plugin format and does not read \`claude mcp add\`. Add the server to \`~/.cursor/mcp.json\` (global) or \`.cursor/mcp.json\` (per project) instead:

\`\`\`json
{
  "mcpServers": {
    "accounted": {
      "url": "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&client=cursor"
    }
  }
}
\`\`\`

## Path C: \`npx accounted-mcp\` with an API key (stdio bridge)

Best for Claude Desktop on a machine where you'd rather use a long-lived API key than the OAuth flow, or for scripting.

1. Mint an API key in the Accounted dashboard under **Settings → API & MCP** (\`/settings/api\`). Use a \`gnubok_sk_test_*\` key against the sandbox while you evaluate; switch to \`gnubok_sk_live_*\` for real data.
2. Add the stdio bridge to your \`claude_desktop_config.json\`:
   \`\`\`json
   {
     "mcpServers": {
       "accounted": {
         "command": "npx",
         "args": ["-y", "accounted-mcp"],
         "env": {
           "ACCOUNTED_API_KEY": "gnubok_sk_test_...",
           "ACCOUNTED_CLIENT": "claude-desktop"
         }
       }
     }
   }
   \`\`\`
   Running Accounted yourself? Point the bridge at your own host with \`ACCOUNTED_URL\`.
3. Restart Claude Desktop. The bridge proxies stdio JSON-RPC to the hosted MCP endpoint over HTTPS; the key carries the scopes you granted it at mint time.

The key's scopes gate exactly which tools are callable: a key without write scopes can read reports and ledgers but cannot stage a booking.

The API-key value still begins with \`gnubok_sk_\`. That is a stable credential
format, not the MCP integration name. Existing \`gnubok-mcp\` configurations
continue to work without changes.

## Try these prompts

All three run against the deterministic sandbox seed (use a \`gnubok_sk_test_*\` key or pick the sandbox company on the OAuth consent screen). They exercise the read path end-to-end without booking anything.

1. **"Show my uncategorized bank transactions and suggest categories."**
   Claude calls \`accounted_list_uncategorized_transactions\` then \`accounted_suggest_categories\` and walks you through the proposals. Approving one stages an \`accounted_categorize_transaction\` pending operation: nothing is booked until you confirm.
2. **"Which invoices are overdue?"**
   Claude calls \`accounted_get_ar_ledger\` (kundreskontra) and lists outstanding customer invoices with aging.
3. **"Compute my VAT report for this quarter and tell me if I can close it."**
   Claude calls \`accounted_get_vat_report\` for the momsdeklaration rutor, then \`accounted_vat_close_check\` to scan for blockers (uncategorised rows, unapproved supplier invoices, missing receipts on expenses ≥ 4 000 kr: the tool's high-value heuristic; BFL requires underlag for every affärshändelse regardless of amount) and reports \`ready_to_close\`.

## 10-minute reviewer test

A quick end-to-end pass to confirm the connection works before you trust it with real data. Run the steps in order; each lists what you do and what you should see.

1. **Connect.** Use Path A (read-only scopes only), Path B, or Path C with a \`gnubok_sk_test_*\` key. → Claude lists the Accounted tools (titles like *List Uncategorized Transactions*, *VAT Declaration (Momsdeklaration)*).
2. **Confirm the company.** Ask *"Which company am I connected to?"* → Claude names the sandbox company (e.g. **Sandlådan Konsult**).
3. **Run prompt 1** (*uncategorized + suggest categories*). → A list of uncategorised rows plus category suggestions; no booking happens.
4. **Run prompt 2** (*overdue invoices*). → At least one overdue customer invoice with aging.
5. **Run prompt 3** (*VAT report + can I close*). → Momsdeklaration rutor returned; \`accounted_vat_close_check\` reports a **non-empty blocker list** (uncategorised transactions, an unapproved leverantörsfaktura, and a high-value business expense without a receipt).
6. **Stage a write.** Ask Claude to categorise one transaction. → Claude stages a pending operation and asks you to confirm: the booking does **not** post until you approve in chat or at **/pending**.

If every step matches, the connector is wired correctly and the approval model is enforced.

## Support

Stuck connecting, or seeing an unexpected blocker? Use the in-app support form at **/help**: it routes straight to the product team with your company context attached. Include the client (claude.ai / Desktop / Code), the path you used (A, B, or C), and the tool name from any error message.
`
