export const CONNECT_CLAUDE_MD = `# Connect with Claude

> Talk to your bookkeeping. Connect Accounted to Claude (claude.ai, Claude Desktop, or Claude Code) and ask questions, categorise transactions, and prepare a momsdeklaration in plain language — every write still stages for your approval first.

Accounted ships an [MCP](https://modelcontextprotocol.io) server that exposes the full bookkeeping engine — 90+ tools — to any MCP client. The endpoint is:

\`\`\`
https://app.gnubok.se/api/extensions/ext/mcp-server/mcp
\`\`\`

There are two ways to connect, depending on your client. Both reach the same tools and the same approval model: read tools answer immediately, write tools (categorise, mark paid, create voucher, year-end) **stage a pending operation** that you confirm in chat or in the **/pending** web UI before anything is booked.

## Path A — claude.ai / Claude Desktop custom connector (OAuth 2.1)

Best for most users. No API key to manage — you authorise Accounted the same way you'd authorise any OAuth app.

1. In **claude.ai** (Settings → Connectors) or **Claude Desktop** (Settings → Connectors → Add custom connector), choose **Add custom connector**.
2. Paste the connector URL:
   \`\`\`
   https://app.gnubok.se/api/extensions/ext/mcp-server/mcp
   \`\`\`
3. Claude opens the Accounted OAuth 2.1 consent screen. Sign in and pick the company you want Claude to act on.
4. On the consent screen you grant **read-only scopes by default** (list invoices, read reports, compute VAT). Write scopes (create invoice, categorise, book vouchers, run year-end) are **listed separately and must be ticked explicitly** — leave them unchecked for a read-only review session.
5. Approve. Claude now lists the Accounted tools and you can start asking questions.

Because the consent is per-company and scoped, you can connect a read-only key for a reviewer and a separate write-enabled connection for day-to-day bookkeeping.

## Path B — \`npx gnubok-mcp\` with an API key (stdio bridge)

Best for Claude Desktop on a machine where you'd rather use a long-lived API key than the OAuth flow, or for scripting.

1. Mint an API key in the Accounted dashboard at **/settings/api**. Use a \`gnubok_sk_test_*\` key against the sandbox while you evaluate; switch to \`gnubok_sk_live_*\` for real data.
2. Add the stdio bridge to your \`claude_desktop_config.json\`:
   \`\`\`json
   {
     "mcpServers": {
       "gnubok": {
         "command": "npx",
         "args": ["gnubok-mcp"],
         "env": {
           "GNUBOK_API_KEY": "gnubok_sk_test_..."
         }
       }
     }
   }
   \`\`\`
3. Restart Claude Desktop. The bridge proxies stdio JSON-RPC to the hosted MCP endpoint over HTTPS; the key carries the scopes you granted it at mint time.

The key's scopes gate exactly which tools are callable — a key without write scopes can read reports and ledgers but cannot stage a booking.

## Try these prompts

All three run against the deterministic sandbox seed (use a \`gnubok_sk_test_*\` key or pick the sandbox company on the OAuth consent screen). They exercise the read path end-to-end without booking anything.

1. **"Show my uncategorized bank transactions and suggest categories."**
   Claude calls \`gnubok_list_uncategorized_transactions\` then \`gnubok_suggest_categories\` and walks you through the proposals. Approving one stages a \`gnubok_categorize_transaction\` pending operation — nothing is booked until you confirm.
2. **"Which invoices are overdue?"**
   Claude calls \`gnubok_get_ar_ledger\` (kundreskontra) and lists outstanding customer invoices with aging.
3. **"Compute my VAT report for this quarter and tell me if I can close it."**
   Claude calls \`gnubok_get_vat_report\` for the momsdeklaration rutor, then \`gnubok_vat_close_check\` to scan for blockers (uncategorised rows, unapproved supplier invoices, missing receipts on expenses ≥ 4 000 kr — the tool's high-value heuristic; BFL requires underlag for every affärshändelse regardless of amount) and reports \`ready_to_close\`.

## 10-minute reviewer test

A quick end-to-end pass to confirm the connection works before you trust it with real data. Run the steps in order; each lists what you do and what you should see.

1. **Connect.** Use Path A (read-only scopes only) or Path B with a \`gnubok_sk_test_*\` key. → Claude lists the Accounted tools (titles like *List Uncategorized Transactions*, *VAT Declaration (Momsdeklaration)*).
2. **Confirm the company.** Ask *"Which company am I connected to?"* → Claude names the sandbox company (e.g. **Sandlådan Konsult**).
3. **Run prompt 1** (*uncategorized + suggest categories*). → A list of uncategorised rows plus category suggestions; no booking happens.
4. **Run prompt 2** (*overdue invoices*). → At least one overdue customer invoice with aging.
5. **Run prompt 3** (*VAT report + can I close*). → Momsdeklaration rutor returned; \`vat_close_check\` reports a **non-empty blocker list** (uncategorised transactions, an unapproved leverantörsfaktura, and a high-value business expense without a receipt).
6. **Stage a write.** Ask Claude to categorise one transaction. → Claude stages a pending operation and asks you to confirm — the booking does **not** post until you approve in chat or at **/pending**.

If every step matches, the connector is wired correctly and the approval model is enforced.

## Support

Stuck connecting, or seeing an unexpected blocker? Use the in-app support form at **/help** — it routes straight to the product team with your company context attached. Include the client (claude.ai / Desktop / Code), the path you used (A or B), and the tool name from any error message.
`
