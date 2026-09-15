---
name: build-connector
description: "Connect an outside system (bank feed, tax agency, e-invoicing network, shop, payment provider, company register) to Accounted the right way: pick the door (in-repo adapter behind a port, remote adapter through Accounted Connect, or an app on the public API), follow the port and contract rules, and pass the gates. Use when adding, changing or reviewing a connector, integration, provider adapter or feed."
---

# Build a connector

Read `docs/BUILDING-CONNECTORS.md` first. It is the reference; this skill
is the order of operations and the checks that are easy to forget.

## Order of operations

1. **Pick the door.** In-repo adapter (self-hosters and Connect run it),
   remote adapter (a service outside the repo, through Connect), or app
   (public API, MCP, webhooks). If unsure: does the source feed a port
   (bank feed, e-invoicing, tax agency)? Then door 1 or 2. Otherwise door 3.
2. **Find the port.** `lib/bank-feed/port.ts`, `lib/invoices/peppol-transport.ts`.
   Create a new port only when two implementations exist or are being built
   together; mirror `lib/bank-feed` (port, registry, registry test).
3. **Write the adapter in an extension**, never in core. Direct adapter on
   own credentials; idempotent registration at module load; provider HTTP
   client separate from the adapter.
4. **Keep the ledger side provider-neutral.** The caller resolves an adapter
   through the registry. No provider branches in sync, ingest, archive.
5. **Contract, if Connect will run it.** Schemas in `packages/connect-contract`
   (shape only, nullable not optional, ISO dates), a scope, a budget
   default, a capability name.
6. **Gates.** `npx vitest run <dir>`, `npm run lint`, `npm run check:types`,
   `npm run check:guards`. Re-baseline `provider-host` with
   `node scripts/checks/no-new-antipatterns.mjs --update` and say so in the
   PR body. Strings in both `messages/sv.json` and `messages/en.json`.
7. **PR body** with a `## First principles` section and the environment
   variables introduced.

## Invariants (refuse to merge without them)

- Booked rows only; pending skipped and counted.
- The ledger mints stored keys; the connector never does.
- Raw provider pages returned verbatim.
- Consents stay on the installation (door 1); remote adapters hold their
  own and say so (door 2).
- Nothing leaves the port's input: no company id, no ledger credential.
- No third-party code in the hosted process; door 2 is HTTP only.

## Worked examples in the repo

- Bank feed port and registry: `lib/bank-feed/`
- Two adapters for one port: `extensions/general/enable-banking/lib/bank-feed/{direct,connect}.ts`
- Transport seam for a provider client: `extensions/general/enable-banking/lib/transport.ts`
- Peppol as a transport registry: `lib/invoices/peppol-transport.ts`, `lib/invoices/transports/`
