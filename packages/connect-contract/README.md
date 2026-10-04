# @accounted/connect-contract

The wire contract between an Accounted ledger installation (the hosted service
or a self-hosted instance) and Accounted Connect, the service that operates
the provider integrations only Accounted can run: bank feeds through its PSD2
credentials, the Skatteverket API client, the Peppol access point, company
lookup, the migration sources, and the collections and delivery providers a
company activates.

This package is shape only: constants, Zod schemas and the TypeScript types
inferred from them. There is no behaviour and no provider code in it, and no
collections or delivery provider is named in it: an installation learns who
the provider is at runtime, from the catalogue. Both sides of the connection
validate with the same schemas so they cannot drift apart, and the package is
MIT so that anyone may implement either side.

## Families

| Family | Base path | Company header | What it covers |
|---|---|---|---|
| Entitlements | `/api/connect/entitlements` | no | the hourly key sync: status, scopes, billing input |
| Bank | `/api/connect/bank/sync` | yes | normalized bank transactions from a PSD2 session |
| Peppol | `/api/connect/peppol` | per operation | lookup, submit, status, evidence, registration, inbound (`PEPPOL_OPERATIONS`) |
| Catalogue | `/api/connect/catalogue` | no | which provider capabilities the key may use, and the provider behind each (`CATALOGUE_OPERATIONS`) |
| Collections | `/api/connect/collections` | per operation | onboarding, cases and their actions, reported payments and credit notes, the change feed, settlements (`COLLECTIONS_OPERATIONS`) |
| Delivery | `/api/connect/delivery` | yes | sending an issued invoice by post, digital mailbox or e-invoice (`DELIVERY_OPERATIONS`) |

Each operation table gives the method, the path under the family's base path,
whether `X-Connector-Company` is required, and the request and response
schemas. Every refusal is the `connectorErrorSchema` envelope with a code from
`CONNECTOR_ERROR_CODES`.

## Headers and versions

- `Authorization: Bearer gnubok_ck_...` (or `x-connector-key`) on every call.
- `X-Connector-Company`: the installation's own opaque company reference.
- `X-Connector-Connection`: the opaque connection handle a provider capability
  returned at onboarding. Only the installation keeps it in clear; the service
  keeps a hash and refuses a handle bound to another key or company
  (`CONNECTOR_CONNECTION_NOT_OWNED`).
- `X-Connect-Contract-Version`: `CONTRACT_VERSION`, on every call of every
  family. The service accepts the current and the previous version, treats a
  missing header as the previous one, and answers
  `CONNECTOR_CONTRACT_VERSION_UNSUPPORTED` for anything older.

`CONTRACT_VERSION` is a date. Fields are only ever added; a breaking change is
a new operation or family, never a changed one. Objects strip keys they do not
know, so an older peer ignores a newer field instead of refusing it. A
response enum only gains a value under a new version, and the service never
sends a value the caller's version does not know.

## Provider capabilities: conventions

These hold for the catalogue, collections and delivery families.

- **Idempotency.** Every write carries `idempotencyKey`, a row id from the
  installation's own database (the case row, the delivery row, the forwarded
  payment row, the connection row plus `:onboard`). The service answers a
  retry with the first result and resolves a timeout by looking up at the
  provider, never by sending again. A second call while the first still runs
  gets `CONNECTOR_IDEMPOTENCY_IN_FLIGHT` (retryable); another body under the
  same key gets `CONNECTOR_IDEMPOTENCY_MISMATCH`. An installation that times
  out keeps its row pending and retries with the same key.
- **Amounts and dates.** Amounts are numbers in the invoice currency (SEK only
  in this version). Amounts the installation sends are rounded to two decimals
  first, and the schemas refuse anything else. Calendar dates are
  `YYYY-MM-DD`; timestamps the installation sends are ISO 8601 with an offset.
- **Personal data.** Personal identity numbers, birth dates and debtor contact
  details travel in requests only. The service stores none of them and strips
  them from every `raw` payload it returns; neither side logs them. A delivery
  method lookup carries identifiers only, and a delivery by post never needs a
  private person's identity number.
- **Change feed.** The installation polls `changes` with an overlap and
  dedupes. A change names its company and the installation's own case or
  delivery id; a settlement change carries the provider's settlement handle.
- **Start work and obligations.** `COLLECTIONS_START_OPERATIONS`, `caseAction`
  with an action in `COLLECTIONS_START_ACTIONS`, and
  `DELIVERY_START_OPERATIONS` begin new work. Every other operation serves an
  open case or stops work (cancelling an activation included). When new work
  is switched off, on either side, start operations are refused
  (`CONNECTOR_UPSTREAM_DISABLED` from the service) and obligations keep
  running, so a case a provider is still working on is never abandoned.
- **Catalogue.** A provider's name, legal identity, terms and fee wording reach
  the installation only here. Parse each entry's `features` with
  `CATALOGUE_FEATURE_SCHEMAS` and skip a capability you do not know. Links are
  https only.

## Use

```ts
import { collectionsOpenCaseRequestSchema, COLLECTIONS_OPERATIONS, CONTRACT_VERSION } from '@accounted/connect-contract'

const parsed = collectionsOpenCaseRequestSchema.safeParse(body)
if (!parsed.success) return badRequest(parsed.error)
```

`src/__tests__/fixtures.ts` holds one valid request and response for every
operation of the catalogue, collections and delivery families, with a
fictional provider and synthetic data; either side may use it in its tests.

## Consuming the package

Inside the Accounted repository the package is consumed from source through a
path alias. It is not published to npm yet: another repository consumes an
exact copy of `src/` pinned to a commit of this public repository, checked
byte for byte in its CI. Never edit such a copy by hand; to move it, re-pin to
a newer commit. That is why `src/` depends on nothing but `zod` and its tests
import nothing outside `src/`.

To build the package output, from the repository root with the root
dependencies installed:

```bash
npx tsc -p packages/connect-contract/tsconfig.json
```
