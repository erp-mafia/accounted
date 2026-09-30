# Accounted plugin for Claude Code

The official plugin for [Accounted](https://app.accounted.se), the open-source Swedish bookkeeping platform. Installing it gives Claude two things at once:

1. **The connection**: the Accounted MCP server (150+ bookkeeping tools, resources, and loadable skills) via OAuth. No API key needed.
2. **The flows**: eight short workflow skills that follow the Swedish bookkeeping rhythm. Each one grounds itself in your company's live data, loads the product's Swedish accounting knowledge when it needs it, and stages every write for your approval. Nothing is ever booked without you saying yes.

## Install

```text
/plugin marketplace add erp-mafia/accounted
/plugin install accounted@accounted
```

Then run `/accounted:setup`. It connects the Accounted connector (`/mcp` → authenticate; no account yet? create it on that sign-in screen, with BankID or e-mail), and for a brand-new account it sets up the company right here in the conversation (company form, organisationsnummer, VAT, fiscal year), then hands you the bank and Skatteverket connect links. After that, `/accounted:start` orients you in the books.

## Skills

| Command | What it does |
|---|---|
| `/accounted:setup` | First run: connect (create the account if needed) and set up the company from the conversation |
| `/accounted:start` | Connect, orient, and surface what needs attention |
| `/accounted:bookkeep` | Clear unbooked bank transactions and receipts (daily) |
| `/accounted:check` | Read-only health check with a prioritized fix list |
| `/accounted:month-close` | Close the month against the product's checklist |
| `/accounted:vat` | Prepare and reconcile the momsdeklaration |
| `/accounted:payroll` | Monthly salary run and AGI underlag |
| `/accounted:year-end` | Bokslut, readiness-gated |
| `/accounted:clients` | Every company on the connection in one table, urgency first; run one task for all of them |
| `/accounted:use` | Pin the current folder to one company (writes `.accounted.json`) |

The skills are deliberately thin: the deep procedural and regulatory content (month-end checklist, VAT rutor, payroll rules, bokslut law) lives server-side in Accounted and is loaded at need via `accounted_load_skill`, so it is always in sync with the product and tailored to your company. `accounted_list_skills` shows everything available.

## How writes work

Every write tool in Accounted stages a **pending operation** with a preview instead of booking directly. Claude shows you the preview; only `accounted_approve_pending_operation`, after your explicit approval, books it. Period locks and Swedish accounting law (immutable vouchers, balanced entries, sequential voucher numbers) are enforced by the product itself.

## Several companies, one connection

The connection belongs to you, not to a company: one sign-in reaches every company you are a member of, and every tool result starts with `company: { company_id, name, is_default }` so you always see whose books an answer came from. When you have more than one company, the flows ask once which company the task concerns (or whether it spans all of them) before writing anything.

Skip that question by pinning a folder:

```text
/accounted:use Nordic Kaffe AB
```

It writes `.accounted.json` in the current folder (`{ "company_id": "...", "name": "Nordic Kaffe AB" }`), and every flow started from that folder, or any folder below it, targets that company. Run it again to re-pin, delete the file to unpin.

For a byrå the pattern is one folder per client: `klienter/nordic-kaffe/`, `klienter/bergs-bygg/`, each pinned with `/accounted:use`. Open the client's folder and `/accounted:bookkeep` or `/accounted:vat` already knows whose books it is in. From any folder, `/accounted:clients` gives the whole portfolio in one table (unbooked, inbox, next deadline, last booked), most urgent first, and "kör momskollen för alla" runs one read tool per client or stages one write per client as a batch that you approve per company or all at once. High-risk operations are always approved one by one.

## Self-hosted

Point the MCP connection at your own instance instead: remove the bundled server and add your own with `claude mcp add --transport http accounted "https://your-host/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"`, or use the [`accounted-mcp`](https://www.npmjs.com/package/accounted-mcp) stdio bridge with your existing Accounted API key.

## Disclaimer

This plugin is not legal, tax, or audit advice. Output is underlag for you and your accountant. Nothing is filed or sent anywhere automatically.

## License

The plugin in this directory is MIT licensed; see [LICENSE](./LICENSE). The Accounted platform it connects to is a separate work, licensed AGPL-3.0 under the [LICENSE](../../LICENSE) at the repository root.
