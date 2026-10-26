/**
 * Auto-generated API reference pages.
 *
 * Iterates lib/api/v1/registry.ts ENDPOINTS, groups by resource (derived
 * from the URL path), and renders one Markdown page per resource. Stripe-
 * style: each endpoint section has the description, useWhen, doNotUseFor,
 * pitfalls, scope, idempotent/reversible/dryRun flags, and a worked example.
 *
 * To make this work, every v1 route file needs to import-side-effect call
 * registerEndpoint(): which they all do at module load time. The doc
 * builder triggers that load via lib/api/v1/load-routes.ts.
 *
 * Adding a new endpoint means editing the route file's registerEndpoint
 * call; the docs then surface it on the next build with no manual sync.
 */

import {
  listEndpoints,
  queryParameters,
  responseJsonSchema,
  zodToJsonSchema,
  NoBodyResponse,
  type EndpointDefinition,
  type HttpMethod,
  type JsonSchema,
} from '@/lib/api/v1/registry'
// Side-effect import: every v1 route file's top-level registerEndpoint()
// call runs as a result of loading this module, populating the shared
// ENDPOINTS map that listEndpoints() reads from.
import '@/lib/api/v1/load-routes'

interface ResourceGroup {
  /** URL slug, used in /docs/api/reference/{slug}. */
  slug: string
  /** Display label for headings + nav. */
  label: string
  /** One-line description for the resource landing card. */
  description: string
  /** URL pattern segment that identifies endpoints belonging to this resource. */
  matcher: (path: string) => boolean
}

const RESOURCES: ResourceGroup[] = [
  { slug: 'companies', label: 'Companies', description: 'List, create and read the companies the API key can access, and read and update their settings: payment, contact and invoicing, the tax and VAT profile, the skattekonto account, and the bookkeeping lock.', matcher: (p) => /\/companies(?:\/:companyId)?(?:\/settings(?:\/(?:tax-profile|bookkeeping-lock|skattekonto-account))?)?$/.test(p) },
  { slug: 'capabilities', label: 'Capabilities', description: 'Which building blocks (the modules behind the OpenAPI tags) a company can use right now, each with a status, the reasons behind it and a resolution sentence. Read-only: the per-company module switch arrives later.', matcher: (p) => /\/companies\/:companyId\/capabilities$/.test(p) },
  { slug: 'measures', label: 'Measures', description: 'Defined figures an agent can quote: moms att betala, kundfordringar, banksaldo, resultat hittills and more. Each value is taken from the report a person sees, carries its definition and an explain call down to every account and line, and refuses with a reason instead of answering zero.', matcher: (p) => /\/companies\/:companyId\/measures(\/|$)/.test(p) },
  { slug: 'packages', label: 'Packages', description: 'The packages a company switches (Lön, Kundfakturor, Kassa och webbshop, ...) with their status: on, off, winding down (switched off while obligations are open: visible, no new work starts), not in plan or not in country. Switching one on or off is staged for an owner or admin to approve.', matcher: (p) => /\/companies\/:companyId\/packages(\/|$)/.test(p) },
  { slug: 'unexplained', label: 'Unexplained', description: 'The queue of differences that should be zero: kundreskontra against booked receivables, leverantörsreskontra against booked payables, bank against books, skattekonto against Skatteverket, declared moms not moved to the settlement account, and bank rows unbooked past the booking deadline. Each result is ok, unexplained or cannot_check with a reason, reads both figures from the reports a person sees, and explains itself down to the invoices, verifikat and bank rows behind it.', matcher: (p) => /\/companies\/:companyId\/unexplained(\/|$)/.test(p) },
  { slug: 'portfolio', label: 'Portfolio', description: 'Cross-company reads for keys that reach more than one company: one overview call over a membership-checked scope (all, byrå team, or explicit ids) instead of one call per company.', matcher: (p) => /\/portfolio(\/|$)/.test(p) },
  { slug: 'customers', label: 'Customers', description: 'CRM-side: who you invoice. Business and individual (sole-trader) customers with VIES validation.', matcher: (p) => /\/customers(\/|$)/.test(p) },
  { slug: 'invoices', label: 'Invoices', description: 'Outbound invoicing: draft, send, mark paid, credit, PDF download. Mixed-rate VAT supported.', matcher: (p) => /\/invoices(\/|$)/.test(p) && !/\/collection(\/|$)/.test(p) },
  { slug: 'collections', label: 'Collections', description: 'Overdue invoices handed to the collections provider the company activated: the candidates and their checks, the case on each invoice, actions on it (pause, resume, withdraw, dispute, or what the provider waits for), and booking what the provider collected and paid out. The handover and the escalations are staged for a person to approve in Accounted (?stage=true; a direct call answers STAGE_REQUIRED).', matcher: (p) => /\/collections\//.test(p) || /\/invoices\/[^/]+\/collection(\/|$)/.test(p) },
  { slug: 'articles', label: 'Articles', description: 'Read the article/product catalogue used to build invoice line items.', matcher: (p) => /\/articles(\/|$)/.test(p) },
  { slug: 'setoffs', label: 'Set-offs', description: 'Kvittning: a counterparty that is both customer and supplier as one relation (open customer and supplier invoices, the net per currency, its set-offs), and setting an open customer invoice off against an open supplier invoice of the same counterparty. Served while the company has set-offs switched on.', matcher: (p) => /\/setoffs(\/|$)/.test(p) },
  { slug: 'suppliers', label: 'Suppliers', description: 'AP-side counterparties. Mirrors customers on the supplier vertical.', matcher: (p) => /\/suppliers(\/|$)/.test(p) },
  { slug: 'supplier-invoices', label: 'Supplier invoices', description: 'AP lifecycle: register, approve, book (deferred booking), mark paid, credit. With ROT/RUT and reverse-charge support.', matcher: (p) => /\/supplier-invoices(\/|$)/.test(p) },
  { slug: 'supplier-payment-batches', label: 'Supplier payment files', description: 'Betalfil (pain.001) for supplier invoices: preview what can be paid, create a batch, download the file for the bank, cancel.', matcher: (p) => /\/supplier-payment-batches(\/|$)/.test(p) },
  { slug: 'payment-orders', label: 'Bank payments', description: 'Betalningar via banken for supplier invoices: prepare and approve payment orders, read their bank status, cancel, check the company verification, and fetch the link where a person signs with BankID. Agents prepare; a person signs.', matcher: (p) => /\/(?:payment-orders|payments)(\/|$)/.test(p) && !/\/collections\//.test(p) },
  { slug: 'expense-claims', label: 'Expense claims', description: 'Utlägg: costs an owner or employee paid privately. Register, list, delete, record the payout, and match a bank payout to open claims.', matcher: (p) => /\/expense-claims(\/|$)/.test(p) || /\/transactions\/:id\/match-expense-payout$/.test(p) },
  { slug: 'transactions', label: 'Transactions', description: 'Bank transactions: ingest, categorise, match to invoices, reconcile.', matcher: (p) => /\/transactions(\/|$)/.test(p) },
  { slug: 'reconciliation', label: 'Reconciliation', description: 'Run bank-to-ledger reconciliation and read the current matching status.', matcher: (p) => /\/reconciliation(\/|$)/.test(p) },
  { slug: 'bank-accounts', label: 'Bank accounts', description: 'The company\'s bank accounts (cash accounts, whose ids filter transactions), the bank connections that sync them and the Open Payments bank feed (reachable banks, connections, switch progress, the signatory link).', matcher: (p) => /\/(?:cash-accounts|bank-connections|bank-feed)(\/|$)/.test(p) },
  { slug: 'pos-sales', label: 'POS sales', description: 'Point-of-sale (kassasystem) venues connected through Accounted Connect, the business days they deliver, and booking a day as its daily takings voucher (gemensam verifikation) with the day report as underlag.', matcher: (p) => /\/pos-sales(\/|$)/.test(p) },
  { slug: 'webshop-orders', label: 'Webshop orders', description: 'The order and refund rows the Shopify, WooCommerce and Zettle syncs deliver (VAT per rate, country, booking status), one order with the booking the Orders page would prefill, and booking one order with your own lines, linked to the order with its orderunderlag.', matcher: (p) => /\/webshop-orders(\/|$)/.test(p) },
  { slug: 'journal-entries', label: 'Journal entries', description: 'The bookkeeping engine surface: verifikation lifecycle (draft, commit, reverse, correct).', matcher: (p) => /\/journal-entries(\/|$)/.test(p) },
  { slug: 'voucher-gap-explanations', label: 'Voucher gap explanations', description: 'Documented explanations for gaps in the voucher series, per BFNAR 2013:2.', matcher: (p) => /\/voucher-gap/.test(p) },
  { slug: 'fiscal-periods', label: 'Fiscal periods', description: 'Fiscal years and their lifecycle: create, edit, lock, unlock, close, year-end, opening balances, FX revaluation, and klarmarkering of years closed in a previous system.', matcher: (p) => /\/fiscal-periods(\/|$)/.test(p) },
  { slug: 'accounts', label: 'Accounts', description: 'The chart of accounts (BAS): read, add, edit, activate, deactivate and delete unused accounts.', matcher: (p) => /\/accounts(\/|$)/.test(p) },
  { slug: 'fixed-assets', label: 'Fixed assets', description: 'The anläggningsregister: register an asset (no voucher, the purchase is already booked), correct it while no depreciation is posted, and dispose it, which posts the avyttring voucher with gain or loss, VAT and jämkning.', matcher: (p) => /\/assets(\/|$)/.test(p) },
  { slug: 'documents', label: 'Documents', description: 'Underlag: multipart upload, list and read metadata, signed-URL download (15-min TTL), link to journal entries, delete an unlinked document.', matcher: (p) => /\/documents(\/|$)/.test(p) },
  { slug: 'inbox-items', label: 'Inbox items', description: 'The invoice inbox: list and read items, correct the extracted fields, convert an item to a supplier invoice, unmatch a transaction, stamp or delete an item.', matcher: (p) => /\/inbox-items(\/|$)/.test(p) },
  { slug: 'dimensions', label: 'Dimensions', description: 'Cost-centre / project dimensions and their values for tagging journal lines.', matcher: (p) => /\/dimensions(\/|$)/.test(p) },
  { slug: 'employees', label: 'Employees', description: 'Payroll roster: CRUD with personnummer masking on list endpoints.', matcher: (p) => /\/employees(\/|$)/.test(p) },
  { slug: 'salary-runs', label: 'Salary runs', description: 'Payroll lifecycle: create, calculate, approve, mark paid, book, generate AGI XML, and close the vacation year.', matcher: (p) => /\/salary-runs(\/|$)|\/salary\//.test(p) },
  { slug: 'reports', label: 'Reports', description: 'Reports and filing: trial balance, P&L, balance sheet, GL, VAT with eSKD and the settlement, INK2 and NE-bilaga with SRU files, periodisk sammanställning, cash flow, KPI, behandlingshistorik, bokslutsbilagor, the audit trail, SIE export and more.', matcher: (p) => /\/(?:reports|audit-trail|vat)(\/|$)/.test(p) },
  { slug: 'imports', label: 'Imports', description: 'Bulk async ingest: SIE files (Fortnox/Visma/BL/SpeedLedger/Bokio migrations) and bank statements (12 formats).', matcher: (p) => /\/imports(\/|$)/.test(p) },
  { slug: 'compliance', label: 'Compliance check', description: 'Pre-flight verification: voucher gaps, year-end readiness, before submitting to Skatteverket.', matcher: (p) => /\/compliance(\/|$)/.test(p) },
  { slug: 'skatteverket', label: 'Skatteverket', description: 'Skatteverket: filed VAT declarations and their decisions, AGI pre-validation, and syncing the skattekonto now.', matcher: (p) => /\/(?:skatteverket|skattekonto)(\/|$)/.test(p) },
  { slug: 'peppol', label: 'Peppol', description: 'Peppol e-invoicing for the company: participant registration status, registering to receive, and requesting access. Sending an invoice over Peppol is on the invoices page.', matcher: (p) => /\/companies\/:companyId\/peppol(\/|$)/.test(p) },
  { slug: 'webhooks', label: 'Webhooks', description: 'Subscribe to events with HMAC-signed delivery, exponential retries, and dead-letter replay.', matcher: (p) => /\/webhooks|\/webhook-deliveries/.test(p) },
  { slug: 'operations', label: 'Operations', description: 'Poll long-running async operations (year-end closing, imports, currency revaluation).', matcher: (p) => /\/operations(\/|$)/.test(p) },
  { slug: 'pending-operations', label: 'Pending operations', description: 'The approval door for staged writes: list and read pending operations with their status and task_state, approve one (commit it and get the outcome) or reject it. A write sent with ?stage=true waits here until it is decided.', matcher: (p) => /\/pending-operations(\/|$)/.test(p) },
  { slug: 'health', label: 'Health', description: 'Unauthenticated liveness check.', matcher: (p) => /^\/api\/v1\/health$/.test(p) },
  { slug: 'api-key', label: 'API key', description: 'What the calling key may do: its mode, scopes, and the companies it reaches with write access per company. Any valid key may call it.', matcher: (p) => /^\/api\/v1\/api-key$/.test(p) },
  { slug: 'service-accounts', label: 'Service accounts', description: 'An integration\'s own principal with a human sponsor: create, list, read and revoke service accounts, and mint or revoke their keys. Writes by their keys are recorded as the service account, acting for the sponsor.', matcher: (p) => /\/service-accounts(\/|$)/.test(p) },
]

/** Discover the resource a given endpoint path belongs to. Returns null if it doesn't fit any. */
function classifyEndpoint(path: string): ResourceGroup | null {
  for (const r of RESOURCES) {
    if (r.matcher(path)) return r
  }
  return null
}

export interface BuiltResourcePage {
  slug: string
  label: string
  description: string
  endpoints: EndpointDefinition[]
  markdown: string
}

const METHOD_ORDER: Record<HttpMethod, number> = { GET: 0, POST: 1, PATCH: 2, PUT: 3, DELETE: 4 }

function endpointAnchor(ep: EndpointDefinition): string {
  return `${ep.method.toLowerCase()}-${ep.operation.replace(/\./g, '-')}`
}

/**
 * Markdown table cells: a pipe would end the cell, a newline the row.
 * Backslashes are escaped first, or a `\` already in the text (a regex in a
 * description) would swallow the escape added in front of the next pipe.
 */
export function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

/** A JSON Schema condensed to the type a reader needs: `"a" | "b"`, `string | null`, `object[]`. */
function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  const union = schema.anyOf ?? schema.oneOf
  if (union) return [...new Set(union.map(schemaType))].join(' | ')
  if (Array.isArray(schema.type)) {
    // The null member of `type: [T, "null"]` must not inherit T's properties,
    // or a nullable object renders as `object | object`.
    return schema.type.map((t) => (t === 'null' ? 'null' : schemaType({ ...schema, type: t }))).join(' | ')
  }
  if (schema.type === 'array') {
    const item = schema.items ? schemaType(schema.items) : 'unknown'
    return item.includes(' ') ? `(${item})[]` : `${item}[]`
  }
  if (schema.type === 'object' || schema.properties) return 'object'
  if (schema.type === 'integer') return 'number'
  return schema.type ?? 'unknown'
}

interface FieldRow {
  name: string
  type: string
  required: boolean
  description?: string
}

function renderTable(title: string, rows: FieldRow[], withRequired: boolean): string[] {
  if (rows.length === 0) return []
  const withDescription = rows.some((r) => r.description)
  const header = ['Name', 'Type', ...(withRequired ? ['Required'] : []), ...(withDescription ? ['Description'] : [])]
  const lines = [`**${title}**`, '', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const r of rows) {
    const cells = [
      `\`${r.name}\``,
      cell(r.type),
      ...(withRequired ? [r.required ? 'yes' : 'no'] : []),
      ...(withDescription ? [cell(r.description ?? '')] : []),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')
  return lines
}

function fieldRows(schema: JsonSchema, prefix = ''): FieldRow[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
    name: `${prefix}${name}`,
    type: schemaType(prop),
    required: required.has(name),
    description: prop.description,
  }))
}

/**
 * The record a response is about: the `data` object, or the items of a list
 * (`data: [...]`, or `data: { accounts: [...] }` with a single array field),
 * so the table lists the fields a client reads rather than the envelope.
 */
function responseRows(ep: EndpointDefinition): FieldRow[] {
  if (ep.response.success === NoBodyResponse) return []
  if (ep.response.contentType && ep.response.contentType !== 'application/json') return []
  const data = responseJsonSchema(ep).properties?.data
  if (!data) return []
  if (data.type === 'array' && data.items?.properties) return fieldRows(data.items, '[].')
  const props = Object.entries(data.properties ?? {})
  if (props.length === 1) {
    const [name, only] = props[0]!
    if (only.type === 'array' && only.items?.properties) return fieldRows(only.items, `${name}[].`)
  }
  return fieldRows(data)
}

function requestBodyRows(ep: EndpointDefinition): FieldRow[] {
  if (!ep.request?.body) return []
  return fieldRows(zodToJsonSchema(ep.request.body))
}

function renderEndpoint(ep: EndpointDefinition): string {
  const lines: string[] = []
  const methodBadge = ep.method
  lines.push(`### \`${methodBadge}\` ${ep.path} {#${endpointAnchor(ep)}}`)
  lines.push('')
  const access =
    ep.scope === 'authenticated' ? ' · any valid key, no scope' : ep.scope ? ` · scope \`${ep.scope}\`` : ' · public'
  lines.push(`**\`${ep.operation}\`**${access}`)
  lines.push('')
  lines.push(ep.summary)
  lines.push('')
  lines.push(ep.description)
  lines.push('')
  lines.push(`**Use when:** ${ep.useWhen}`)
  lines.push('')
  lines.push(`**Don't use for:** ${ep.doNotUseFor}`)
  lines.push('')
  if (ep.pitfalls.length > 0) {
    lines.push('**Pitfalls**')
    for (const p of ep.pitfalls) lines.push(`- ${p}`)
    lines.push('')
  }
  const flags: string[] = []
  flags.push(`**Risk:** ${ep.risk}`)
  flags.push(`**Idempotent:** ${ep.idempotent ? 'yes' : 'no'}`)
  flags.push(`**Reversible:** ${ep.reversible ? 'yes' : 'no'}`)
  flags.push(`**Dry-run supported:** ${ep.dryRunSupported ? 'yes' : 'no'}`)
  if (ep.stageSupported) flags.push('**Stage for approval:** yes (`?stage=true`)')
  lines.push(flags.join(' · '))
  lines.push('')
  // The same schemas the OpenAPI spec publishes, as tables: before #2515 the
  // page carried prose and one example, and the example was the only field
  // reference a reader had.
  lines.push(
    ...renderTable(
      'Query parameters',
      queryParameters(ep).map((p) => ({
        name: p.name,
        type: schemaType(p.schema),
        required: p.required,
        description: p.description,
      })),
      true,
    ),
  )
  lines.push(...renderTable('Request body', requestBodyRows(ep), true))
  lines.push(
    ...renderTable(
      'Response fields',
      responseRows(ep).map((r) => (r.required ? r : { ...r, type: `${r.type} (optional)` })),
      false,
    ),
  )
  if (ep.example.request) {
    lines.push('**Example request**')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(ep.example.request, null, 2))
    lines.push('```')
    lines.push('')
  }
  lines.push('**Example response**')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(ep.example.response, null, 2))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

// Module-level memoisation. The endpoint registry is populated once at
// module load (via the side-effect import of load-routes) and is then
// immutable for the process lifetime. The Markdown serialisation is
// pure derivation: reusing a single result avoids repeated work on the
// .md route handlers (which Next.js doesn't statically pre-render) AND
// halves the cost on each generateMetadata + page render pair on the
// HTML routes. (Greptile P2, round 1.)
let cachedPages: BuiltResourcePage[] | null = null

export function buildResourcePages(): BuiltResourcePage[] {
  if (cachedPages) return cachedPages

  const all = listEndpoints()
  const byResource = new Map<string, EndpointDefinition[]>()
  for (const ep of all) {
    const r = classifyEndpoint(ep.path)
    if (!r) continue
    if (!byResource.has(r.slug)) byResource.set(r.slug, [])
    byResource.get(r.slug)!.push(ep)
  }

  const pages = RESOURCES.map((r) => {
    const endpoints = (byResource.get(r.slug) ?? []).sort((a, b) => {
      const m = METHOD_ORDER[a.method] - METHOD_ORDER[b.method]
      if (m !== 0) return m
      return a.path.localeCompare(b.path)
    })

    const lines: string[] = []
    lines.push(`# ${r.label}`)
    lines.push('')
    lines.push(`> ${r.description}`)
    lines.push('')

    if (endpoints.length === 0) {
      lines.push('*No endpoints registered yet for this resource.*')
    } else {
      lines.push('## Endpoints')
      lines.push('')
      for (const ep of endpoints) {
        lines.push(`- [\`${ep.method}\` \`${ep.path}\`](#${endpointAnchor(ep)}): ${ep.summary}`)
      }
      lines.push('')
      lines.push('---')
      lines.push('')
      for (const ep of endpoints) {
        lines.push(renderEndpoint(ep))
        lines.push('---')
        lines.push('')
      }
    }

    return {
      slug: r.slug,
      label: r.label,
      description: r.description,
      endpoints,
      markdown: lines.join('\n'),
    }
  })

  cachedPages = pages
  return pages
}

export function buildReferenceOverviewMd(): string {
  const lines: string[] = []
  lines.push('# API reference')
  lines.push('')
  lines.push(`> Every endpoint exposed by the Accounted REST API, grouped by resource. Auto-generated from the same Zod registry that powers the [OpenAPI 3.1 spec](/api/v1/openapi.json), the MCP tool surface, and runtime validators: there is no separate doc-source to keep in sync.`)
  lines.push('')
  lines.push('## Resources')
  lines.push('')
  for (const r of RESOURCES) {
    lines.push(`### [${r.label}](/docs/api/reference/${r.slug})`)
    lines.push('')
    lines.push(r.description)
    lines.push('')
  }
  return lines.join('\n')
}

export const RESOURCE_SLUGS = RESOURCES.map((r) => r.slug)
