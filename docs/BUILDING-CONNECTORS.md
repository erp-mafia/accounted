# Building a connector for Accounted

How to connect an outside system (a bank feed, a tax agency, an e-invoicing
network, a shop, a payment provider, a company register) to Accounted, and
how to get it in front of users. This is the reference for contributors,
for self-hosters wiring their own sources, and for third parties who want
to offer a connector through Accounted Connect.

Three kinds of connector exist. Pick the door first; everything else follows
from it.

| Door | You write | It runs | It reaches the ledger through | Who gates it |
|---|---|---|---|---|
| 1. Adapter in the repo | TypeScript in this repository | Inside the ledger (self-hosted or hosted) or inside Accounted Connect | A port | Pull request, reviewed by maintainers |
| 2. Remote adapter | A service you host | Your servers | The port's wire contract, through Accounted Connect | Registration with Connect, conformance, listing |
| 3. App | Anything | Your servers | The public v1 API, MCP tools, signed webhooks | An API key with scopes |

Rules that hold for every door:

- **The ledger computes its own stored keys.** A connector never mints
  transaction ids or dedup keys. It returns booked rows with a real booking
  date, and the ledger derives everything it stores from those.
- **Booked rows only.** Pending rows have no stable date and are dropped by
  the connector, counted, and reported as skipped.
- **Raw payloads travel verbatim.** Whatever the provider answered is
  returned as raw pages next to the normalized rows. The ledger archives
  them (räkenskapsinformation, BFL 7 kap.) and they are the escape hatch
  when a field the model lacks turns out to matter.
- **Consents stay on the installation.** A connector receives a session or
  token per call when it needs one; it never owns the user's consent.
  Remote adapters are the exception by design (see door 2).
- **No third-party code runs inside the hosted process.** Door 1 is
  compiled from a static list and reviewed; door 2 runs on your servers;
  door 3 never runs on ours.

---

## Door 1: an adapter in the repository

Use this when the source should be available to every self-hoster with
their own credentials, or when Accounted Connect should run it.

### 1. Find or define the port

A port is the ledger's contract for one capability. Ports live in core and
are written in domain terms, never in a provider's terms.

| Capability | Port | Registry | Worked example |
|---|---|---|---|
| Bank feed | `lib/bank-feed/port.ts` | `lib/bank-feed/registry.ts` | `extensions/general/enable-banking/lib/bank-feed/` |
| E-invoicing (Peppol) | `lib/invoices/peppol-transport.ts` (`PeppolTransport`) | `registerPeppolTransport`, selection in `lib/invoices/transports/index.ts` | `lib/invoices/transports/qvalia.ts`, `lib/invoices/transports/connector.ts` |
| Tax agency (Skatteverket) | Port pending; today `extensions/general/skatteverket/lib/api-client.ts` with a transport seam in `connector-mode.ts` | | |

If your capability has no port yet, create one only when a second
implementation exists or is being built at the same time (for example a
direct adapter and the Connect adapter). One implementation does not
justify an interface. Mirror `lib/bank-feed`: a `port.ts` with the types
and the adapter interface, a `registry.ts` with register, resolve and a
test hook, and a `__tests__/registry.test.ts`.

A port interface names what the ledger needs and nothing about how a
provider works:

```ts
export interface BankFeedAdapter {
  readonly provider: string          // 'enable-banking', 'connect', ...
  readonly needsSessionId: boolean   // receives the connection's session per call
  syncBooked(input: BankFeedSyncInput): Promise<BankFeedSyncResult>
}
```

### 2. Write the adapter inside an extension

Provider code belongs in an extension under `extensions/general/<name>/`,
never in core. Scaffold one with the `create-extension` skill or
`npx tsx scripts/create-extension.ts`, enable it in `extensions.config.json`
and run `npm run setup:extensions`. Core must build with zero extensions,
so core files never import from `@/extensions/`.

Inside the extension:

- `lib/<capability>/direct.ts`: the adapter on the installation's own
  credentials. Read credentials from environment variables with a clear
  prefix, document them in `.env.example` and `docs/SELF-HOSTING.md`.
- `lib/<capability>/index.ts`: an idempotent `ensure...Adapters()` that
  registers the adapter, called at extension module load (see
  `extensions/general/enable-banking/index.ts`) and by any entry point that
  resolves an adapter.
- Keep the provider's HTTP client separate from the adapter so the same
  client can run behind a different transport later.

The ledger side of a sync stays provider-neutral: the caller resolves an
adapter through the registry, gets booked rows, and does external ids,
ingest, archive and balances itself. Do not add provider branches to that
code.

### 3. Tests and gates

- Unit tests next to the code (`__tests__/`), mocking the provider's HTTP
  with `fetch`. Cover: normalization of a booked row, pending rows skipped,
  the session-expired shape, a provider error, and the registry picking your
  adapter.
- `npx vitest run <dir>` while iterating, then `npm run lint`,
  `npm run check:types`, `npm run check:guards`.
- The `provider-host` guard refuses new files that call a provider's API host
  directly. An adapter is exactly that, so re-baseline with
  `node scripts/checks/no-new-antipatterns.mjs --update` and say so in the
  PR body: the guard exists to keep provider hosts out of core and out of
  unrelated code, not to block adapters.
- New user-facing strings go in both `messages/sv.json` and `messages/en.json`.
- If the adapter needs a migration, use the `supabase-migration` skill and
  ship a `*.pg.test.ts` for any trigger, RPC or policy.

### 4. Make it reachable through Accounted Connect (optional)

If Accounted should be able to run your adapter for installations without
their own credentials, the same adapter code gets a route in the Connect
service in one of three shapes:

| Shape | When | What Connect does |
|---|---|---|
| Proxy | The provider's API is per-user token based and the installation already holds the token | Forwards verbatim and adds Accounted's gateway or app credentials |
| Operation | Provider logic is worth running once, centrally (paging, recovery, normalization) | Runs the adapter and returns the port's model plus raw pages |
| Owned feed | The provider pushes events to a single webhook URL | Receives, archives, and lets installations poll |

Add the request and response schemas to `packages/connect-contract` (MIT,
Zod, shape only), a scope name for the key, a budget default, and a
capability name in the entitlements. Both sides validate with the same
schemas.

### 5. Open the pull request

Title in Conventional Commits, a `## First principles` section that says
why the source needs a connector and what could not be done with a manual
file import, the environment variables it introduces, and the guard
re-baseline if any. A maintainer reviews. Merged adapters ship to every
self-hoster in the next release and, when wired, to Connect.

---

## Door 2: a remote adapter through Accounted Connect

Use this when you run a service of your own (an aggregator, a collection
agency, a shop platform integration) and want Accounted installations to
use it without your code entering the repository.

You implement one port's wire contract as an HTTPS service. Accounted
Connect calls your service on behalf of installations, validates every
answer against the contract, meters the calls, and returns the result to
the installation. The installation never learns your service exists; it
resolves the capability to Connect exactly as it does for Accounted's own
adapters.

### The contract

`@accounted/connect-contract` (`packages/connect-contract/src/index.ts`)
holds the schemas. For a bank feed, your endpoint receives the body of
`bankSyncRequestSchema` and answers with `bankSyncResponseSchema`:

```ts
// request (Connect -> your service)
{ session_id, account_uid, account_currency, date_from?, date_to?, strategy? }

// response (your service -> Connect)
{ transactions: NormalizedBankTransaction[], raw_pages: string[],
  skipped_pending, returned_min_booking_date, returned_max_booking_date,
  effective_date_from, pages }

// on failure: the error envelope
{ error: string, code: 'CONNECTOR_...' }
```

Every field of `NormalizedBankTransaction` is nullable rather than optional,
`booking_date` is a real ISO calendar date, and `description` is never empty.
Return only booked rows. Return the provider's pages verbatim in `raw_pages`.

Headers on every call from Connect, once the registry ships: an opaque
install id (never a company id), the contract version, and a signature you
verify with the per-adapter secret you receive at registration.

### Consent

For a remote adapter the consent lives with you: your service holds the
bank session or the shop token, Accounted holds a handle. Installation
starts the consent, Connect bounces to your authorize URL with signed state,
you return the handle when the user has consented. This is the one place
where the "consents stay on the installation" rule is relaxed, because the
alternative does not exist.

### Getting registered

Today this happens by arrangement: write to the maintainers with the port
you implement, your endpoint, where you process data (an EU region is
expected for Swedish bookkeeping data), and your price. Connect issues a
developer key and registers the adapter for the installations that want
it, unlisted first. Listing in the catalog follows a conformance run of
Accounted's fixtures against your endpoint and a human review.

The self-serve version of this (developer accounts, a conformance command,
the catalog, revenue share) is roadmap step 7 in the Connect plan and is
built when the first counterparty is ready. Ask; being first shapes it.

---

## Door 3: an app on the public API

Use this for everything that is not a feed into a port: a CRM, a dashboard,
a reporting tool, an agent, an e-commerce sync that reads and writes
through the same surface a user has.

- **API keys.** Settings > API in Accounted issues `gnubok_sk_` keys with
  scopes. A key acts as the user who created it, inside the companies that
  user belongs to.
- **REST.** The v1 API is described at `/api/v1/openapi.json` on any
  installation: companies, journal entries, invoices, customers, suppliers,
  cash accounts, settings, operations.
- **MCP.** The `accounted-mcp` package exposes the bookkeeping engine as
  tools for agents, authenticated with the same keys.
- **Webhooks.** Signed deliveries for public events; failed deliveries can be
  retried through `/api/v1/webhook-deliveries/{id}/retry`.
- **Rules.** Every write goes through the same engine and the same period
  locks as the UI. There is no way around the accounting invariants, by
  design.

---

## Choosing the shape for a source

| Source type | Example | Door | Shape on Connect |
|---|---|---|---|
| Per-user token, many endpoints | Skatteverket | 1 | Proxy |
| Stateless lookups on Accounted's agreement | SCB, company data | 1 | Operation |
| Session-based feed with paging quirks | Bank via PSD2 | 1 | Operation |
| Webhook-driven platform with one app | Shopify, Stripe events | 1 or 2 | Owned feed |
| Your own aggregator or service | A third-party bank aggregator | 2 | Operation, via your endpoint |
| Reads and writes like a user | CRM, dashboard, agent | 3 | Not on Connect |

## Checklist before you ask for a review

- [ ] The ledger computes stored keys; the connector returns booked rows and raw pages
- [ ] Pending rows are skipped and counted
- [ ] Consents stay on the installation (door 1) or are documented as yours (door 2)
- [ ] No company id, ledger credential or ledger data leaves the port's input
- [ ] Contract schemas validate on both sides; nothing added to core outside the port
- [ ] Tests: normalization, pending skipped, session expired, provider error, registry resolution
- [ ] Guards, lint, types green; provider-host re-baseline justified in the PR
- [ ] Environment variables documented in `.env.example` and `docs/SELF-HOSTING.md`

Related: `docs/EXTENSIONS.md` (the extension system), `docs/SELF-HOSTING.md`
(running with your own credentials or a connector key),
`packages/connect-contract/README.md` (the wire contract).
