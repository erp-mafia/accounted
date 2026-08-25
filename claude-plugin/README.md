# Accounted plugin for Claude Code

The official plugin for [Accounted](https://app.accounted.se), the open-source Swedish bookkeeping platform. Installing it gives Claude two things at once:

1. **The connection**: the Accounted MCP server (90+ bookkeeping tools, resources, and loadable skills) via OAuth. No API key needed.
2. **The flows**: seven short workflow skills that follow the Swedish bookkeeping rhythm. Each one grounds itself in your company's live data, loads the product's Swedish accounting knowledge when it needs it, and stages every write for your approval. Nothing is ever booked without you saying yes.

## Install

```text
/plugin marketplace add erp-mafia/accounted
/plugin install accounted@accounted
```

Then run `/mcp` and authenticate with Accounted (OAuth consent screen; read-only scopes by default, write scopes are ticked explicitly). No account yet? Create it on that same screen, with BankID or e-mail. Start with `/accounted:start`: for a brand-new account it walks you through setting up the company (company form, organisationsnummer, VAT, fiscal year) right here in the conversation, then hands you the bank and Skatteverket connect links.

## Skills

| Command | What it does |
|---|---|
| `/accounted:start` | Connect, orient, and surface what needs attention |
| `/accounted:bookkeep` | Clear unbooked bank transactions and receipts (daily) |
| `/accounted:check` | Read-only health check with a prioritized fix list |
| `/accounted:month-close` | Close the month against the product's checklist |
| `/accounted:vat` | Prepare and reconcile the momsdeklaration |
| `/accounted:payroll` | Monthly salary run and AGI underlag |
| `/accounted:year-end` | Bokslut, readiness-gated |

The skills are deliberately thin: the deep procedural and regulatory content (month-end checklist, VAT rutor, payroll rules, bokslut law) lives server-side in Accounted and is loaded at need via `accounted_load_skill`, so it is always in sync with the product and tailored to your company. `accounted_list_skills` shows everything available.

## How writes work

Every write tool in Accounted stages a **pending operation** with a preview instead of booking directly. Claude shows you the preview; only `accounted_approve_pending_operation`, after your explicit approval, books it. Period locks and Swedish accounting law (immutable vouchers, balanced entries, sequential voucher numbers) are enforced by the product itself.

## Self-hosted

Point the MCP connection at your own instance instead: remove the bundled server and add your own with `claude mcp add --transport http accounted "https://your-host/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"`, or use the [`accounted-mcp`](https://www.npmjs.com/package/accounted-mcp) stdio bridge with your existing Accounted API key.

## Disclaimer

This plugin is not legal, tax, or audit advice. Output is underlag for you and your accountant. Nothing is filed or sent anywhere automatically.

## License

The plugin in this directory is MIT licensed; see [LICENSE](./LICENSE). The Accounted platform it connects to is a separate work, licensed AGPL-3.0 under the [LICENSE](../LICENSE) at the repository root.
