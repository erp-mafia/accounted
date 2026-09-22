import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { isPaymentText, merchantKey, merchantLabel } from './merchant-key'
import { CLUSTER_LABELS, type ClusterId, type CompanyGraph, type GraphLink, type GraphNode } from './types'
import { NOT_STRUCTURED_MIME_FILTER } from '@/lib/documents/read/types'

/**
 * Builds the company graph from the tables that exist. Every query is listed
 * in one fixed order (the unit test enqueues answers in that order), every
 * read is capped, and a cap that was hit marks the graph as truncated.
 *
 * Aggregation is the default: documents fold into one node per group unless
 * an agreement, a fact or a link points at them; counterparties beyond the
 * top twenty by flow fold into one; only accounts with movement appear;
 * upcoming items stay within ninety days.
 */
const MONTHS = 12
const UPCOMING_DAYS = 90
const TOP_PARTIES = 20
/** Bump when the rules that draw the graph change, so stored snapshots are rebuilt instead of served. */
export const GRAPH_VERSION = 3
const LINE_CAP = 20000
const TX_CAP = 5000
/**
 * What a registration drives. A fact from Skatteverket or Bolagsverket is the
 * reason certain accounts move and certain deadlines exist; drawing that as a
 * link is what lets a person (or an agent) walk from "momsregistrerad" to the
 * VAT accounts and the next VAT return without knowing the accounting.
 */
const FACT_RULES: Record<string, { authority: 'skatteverket' | 'bolagsverket'; why: string; accounts?: RegExp; deadlines?: RegExp }> = {
  vat_registered: { authority: 'skatteverket', why: 'VAT registration: the VAT accounts move and VAT returns fall due', accounts: /^26\d\d$/, deadlines: /moms|vat|periodisk/i },
  vat_period: { authority: 'skatteverket', why: 'the VAT period sets when VAT returns fall due', accounts: /^26\d\d$/, deadlines: /moms|vat/i },
  vat_method: { authority: 'skatteverket', why: 'the VAT method decides when VAT is reported', accounts: /^26\d\d$/ },
  employer_registered: { authority: 'skatteverket', why: 'employer registration: payroll taxes are booked and the employer declaration falls due', accounts: /^(27\d\d|75\d\d)$/, deadlines: /arbetsgivar|agi/i },
  f_skatt: { authority: 'skatteverket', why: 'F-skatt: preliminary tax is paid in instalments', deadlines: /f_skatt|skatteinbetalning|preliminär/i },
  fiscal_year: { authority: 'bolagsverket', why: 'the fiscal year sets when the annual report is due', deadlines: /arsredovisning|årsredovisning|annual|bolagsverket|inkomstdeklaration/i },
  org_number: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  legal_name: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  registered_office: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  share_capital: { authority: 'bolagsverket', why: 'registered with Bolagsverket', accounts: /^2081$/ },
  share_count: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  board: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  signatories_rule: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  auditor: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  registration_date: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
  business_description: { authority: 'bolagsverket', why: 'registered with Bolagsverket' },
}
/**
 * What a ledger-derived fact was read from (lib/arkiv/facts/derive-company.ts):
 * salary cost from the pay accounts, revenue from the 3xxx accounts, a
 * baseline or a loan balance from the accounts its evidence names, a top
 * counterparty from the party or merchant node its evidence names.
 */
const LEDGER_FACT_RULES: Record<string, { why: string; accounts?: RegExp }> = {
  monthly_salary_cost: { why: 'averaged from the pay accounts of the last twelve months', accounts: /^7[0-3]\d\d$/ },
  revenue_12m: { why: 'netted from the revenue accounts of the last twelve months', accounts: /^3[0-7]\d\d$/ },
  loan_balance: { why: 'the standing balance of the loan accounts' },
  monthly_cost_baseline: { why: 'the typical month on this account' },
  top_counterparty: { why: 'the money moved with this counterparty in the last twelve months' },
}
/** The account numbers a fact's evidence (one row of sources) names, whether stored as strings or as { account } rows. */
function evidenceAccounts(evidence: Record<string, unknown> | null | undefined): string[] {
  const out = new Set<string>()
  if (typeof evidence?.account === 'string') out.add(evidence.account)
  if (Array.isArray(evidence?.accounts)) {
    for (const a of evidence.accounts) {
      if (typeof a === 'string' && ACCOUNT_NUMBER_RE.test(a)) out.add(a)
      else if (a && typeof a === 'object' && typeof (a as { account?: unknown }).account === 'string') out.add((a as { account: string }).account)
    }
  }
  return [...out]
}
/** A counterparty paid within this many days is active; older ones are drawn faded and say so. */
const ACTIVE_DAYS = 90
const DOC_CAP = 5000

const AUTHORITY_DOC_TYPES: Record<string, 'bolagsverket' | 'skatteverket'> = {
  'registration.bolagsverket': 'bolagsverket',
  'filing.bolagsverket': 'bolagsverket',
  'decision.skatteverket': 'skatteverket',
}
const CORPORATE = new Set(['minutes.board', 'minutes.agm', 'share_subscription_list', 'annual_report'])
const RECEIPTS = new Set(['receipt', 'supplier_invoice', 'credit_note', 'customer_invoice'])
const STATEMENTS = new Set(['bank_statement', 'tax_account_statement'])
const GROUP_LABELS: Record<string, string> = {
  agreements: 'Avtal utan koppling',
  authority: 'Myndighetsdokument',
  corporate: 'Bolagshandlingar',
  receipts_invoices: 'Kvitton och fakturor',
  statements: 'Kontoutdrag',
  other: 'Övriga dokument',
}
const INVOICE_SOURCE_TYPES = new Set(['invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note'])

const round2 = roundOre
/** Thousands separated by a plain space, so text renderings and tests never meet a non-breaking space. */
const kr = (n: number) => Math.round(n).toLocaleString('sv-SE').replace(/\u00a0/g, ' ')
const group = (type: string | null): string =>
  type?.startsWith('agreement.') ? 'agreements' : type && AUTHORITY_DOC_TYPES[type] ? 'authority' : type && CORPORATE.has(type) ? 'corporate' : type && RECEIPTS.has(type) ? 'receipts_invoices' : type && STATEMENTS.has(type) ? 'statements' : 'other'

function isoMonthsBack(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - n)
  return d.toISOString().slice(0, 10)
}
function isoDaysAhead(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function monthKeys(today: string): string[] {
  const keys: string[] = []
  for (let i = MONTHS - 1; i >= 0; i--) keys.push(isoMonthsBack(today, i).slice(0, 7))
  return keys
}

interface LineRow {
  account_number: string | number
  debit_amount: number | string | null
  credit_amount: number | string | null
  journal_entry_id: string
  journal_entries: { entry_date: string; source_type: string; source_id: string | null } | Array<{ entry_date: string; source_type: string; source_id: string | null }>
}

export async function buildCompanyGraph(supabase: SupabaseClient, companyId: string, today: string): Promise<CompanyGraph> {
  const from = isoMonthsBack(today, MONTHS)
  const horizon = isoDaysAhead(today, UPCOMING_DAYS)
  const NONE = '00000000-0000-0000-0000-000000000000'

  // One fixed order. The test enqueues answers in exactly this sequence.
  const company = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle()
  const accounts = await supabase.from('chart_of_accounts').select('account_number, account_name').eq('company_id', companyId).limit(3000)
  const lines = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, journal_entry_id, journal_entries!inner(entry_date, status, source_type, source_id, company_id)')
    .eq('journal_entries.company_id', companyId)
    // A reversed original stays in the ledger and its storno cancels it; the reports sum both, so must the graph.
    .in('journal_entries.status', ['posted', 'reversed'])
    .gte('journal_entries.entry_date', from)
    .limit(LINE_CAP)
  const parties = await supabase.from('parties').select('id, display_name, kind').eq('company_id', companyId).limit(2000)
  const customers = await supabase.from('customers').select('id, party_id').eq('company_id', companyId).not('party_id', 'is', null).limit(2000)
  const suppliers = await supabase.from('suppliers').select('id, party_id').eq('company_id', companyId).not('party_id', 'is', null).limit(2000)
  const invoices = await supabase.from('invoices').select('id, customer_id').eq('company_id', companyId).not('customer_id', 'is', null).limit(DOC_CAP)
  const supplierInvoices = await supabase
    .from('supplier_invoices')
    .select('id, supplier_id, registration_journal_entry_id, payment_journal_entry_id')
    .eq('company_id', companyId)
    .limit(DOC_CAP)
  const agreements = await supabase
    .from('agreements')
    .select('id, title, kind, status, ends_on, amount, period, principal, counterparty_party_id, counterparty_name, source_document_id')
    .eq('company_id', companyId)
    .limit(1000)
  const obligations = await supabase
    .from('agreement_obligations')
    .select('id, agreement_id, kind, due_on, amount, status, transaction_id, direction')
    .eq('company_id', companyId)
    .gte('due_on', from)
    .lte('due_on', horizon)
    .limit(3000)
  const matchedTxIds = ((obligations.data ?? []) as Array<{ transaction_id: string | null }>).map((o) => o.transaction_id).filter((id): id is string => !!id)
  const transactions = await supabase
    .from('transactions')
    .select('id, journal_entry_id')
    .eq('company_id', companyId)
    .in('id', matchedTxIds.length ? matchedTxIds : [NONE])
    .limit(3000)
  // Counterparties known from the bank side: the alias a person or the resolver tied to a party,
  // and every booked transaction of the period, so a loan paid straight from the account has a party too.
  const aliases = await supabase.from('counterparty_aliases').select('alias_key, party_id').eq('company_id', companyId).not('party_id', 'is', null).limit(5000)
  const bookedTx = await supabase
    .from('transactions')
    .select('id, journal_entry_id, original_description, description, merchant_name, date')
    .eq('company_id', companyId)
    .not('journal_entry_id', 'is', null)
    .gte('date', from)
    .limit(TX_CAP)
  const facts = await supabase
    .from('company_facts')
    .select('id, predicate, value_text, valid_from, source_document_id, sources')
    .eq('company_id', companyId)
    .eq('subject_kind', 'company')
    .eq('subject_id', companyId)
    .eq('status', 'confirmed')
    .is('sys_to', null)
    .neq('rank', 'deprecated')
    .limit(200)
  const documents = await supabase
    .from('document_attachments')
    .select('id, file_name, doc_type, created_at, journal_entry_id')
    .eq('company_id', companyId)
    .eq('admission_state', 'admitted')
    .or(NOT_STRUCTURED_MIME_FILTER)
    .order('created_at', { ascending: false })
    .limit(DOC_CAP)
  const documentLinks = await supabase
    .from('document_links')
    .select('document_id, target_kind, party_id, agreement_id, asset_id')
    .eq('company_id', companyId)
    .is('retired_at', null)
    .limit(2000)
  const employees = await supabase
    .from('employees')
    .select('id, first_name, last_name, employment_type, employment_end')
    .eq('company_id', companyId)
    .limit(500)
  const runEmployees = await supabase.from('salary_run_employees').select('salary_run_id, employee_id, gross_salary').eq('company_id', companyId).limit(5000)
  const deadlines = await supabase
    .from('deadlines')
    .select('id, title, due_date, deadline_type, tax_deadline_type, status')
    .eq('company_id', companyId)
    .gte('due_date', today)
    .lte('due_date', horizon)
    .in('status', ['upcoming', 'action_needed', 'in_progress', 'overdue'])
    .limit(100)
  const expected = await supabase
    .from('arkiv_findings')
    .select('id, detail')
    .eq('company_id', companyId)
    .eq('kind', 'document_expected')
    .eq('status', 'open')
    .limit(50)

  for (const r of [company, accounts, lines, parties, customers, suppliers, invoices, supplierInvoices, agreements, obligations, transactions, aliases, bookedTx, facts, documents, documentLinks, employees, runEmployees, deadlines, expected]) {
    if (r.error) throw new Error(`graph read failed: ${r.error.message}`)
  }

  const nodes = new Map<string, GraphNode>()
  const links: GraphLink[] = []
  const linkKeys = new Set<string>()
  let truncated = false
  const add = (n: GraphNode) => {
    const prev = nodes.get(n.ref)
    if (!prev) nodes.set(n.ref, n)
    return nodes.get(n.ref) as GraphNode
  }
  const link = (source: string, target: string, kind: GraphLink['kind'], evidence: Record<string, unknown>) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return
    const key = `${source}|${target}|${kind}`
    if (linkKeys.has(key)) return
    linkKeys.add(key)
    links.push({ source, target, kind, evidence })
  }

  // Ledger: accounts with posted movement in the period, with a monthly series.
  const months = monthKeys(today)
  const monthIndex = new Map(months.map((m, i) => [m, i]))
  const accountName = new Map(((accounts.data ?? []) as Array<{ account_number: string; account_name: string }>).map((a) => [String(a.account_number), a.account_name]))
  const lineRows = (lines.data ?? []) as unknown as LineRow[]
  if (lineRows.length >= LINE_CAP) truncated = true
  const series: Record<string, number[]> = {}
  const movement = new Map<string, number>()
  const entryAccounts = new Map<string, Map<string, number>>() // journal_entry_id -> account -> amount
  const entrySource = new Map<string, { source_type: string; source_id: string | null }>()
  const entryDate = new Map<string, string>()
  for (const l of lineRows) {
    const je = Array.isArray(l.journal_entries) ? l.journal_entries[0] : l.journal_entries
    const account = String(l.account_number)
    const amount = Number(l.debit_amount ?? 0) + Number(l.credit_amount ?? 0)
    movement.set(account, (movement.get(account) ?? 0) + amount)
    const ref = `account:${account}`
    if (!series[ref]) series[ref] = new Array(MONTHS).fill(0)
    const mi = monthIndex.get((je?.entry_date ?? '').slice(0, 7))
    if (mi != null) series[ref][mi] = round2(series[ref][mi] + amount)
    if (!entryAccounts.has(l.journal_entry_id)) entryAccounts.set(l.journal_entry_id, new Map())
    const per = entryAccounts.get(l.journal_entry_id) as Map<string, number>
    per.set(account, (per.get(account) ?? 0) + amount)
    if (je) {
      entrySource.set(l.journal_entry_id, { source_type: je.source_type, source_id: je.source_id })
      if (je.entry_date && (entryDate.get(l.journal_entry_id) ?? '') < je.entry_date) entryDate.set(l.journal_entry_id, je.entry_date)
    }
  }
  for (const [account, total] of movement) {
    add({ ref: `account:${account}`, cluster: 'ledger', kind: 'account', label: `${account} ${accountName.get(account) ?? ''}`.trim(), weight: round2(total), meta: { account, movement: round2(total) } })
  }

  // Counterparties: flow derived from what was booked against invoices and supplier invoices.
  const partyRows = (parties.data ?? []) as Array<{ id: string; display_name: string; kind: string }>
  const partyById = new Map(partyRows.map((p) => [p.id, p]))
  const customerParty = new Map(((customers.data ?? []) as Array<{ id: string; party_id: string }>).map((c) => [c.id, c.party_id]))
  const supplierParty = new Map(((suppliers.data ?? []) as Array<{ id: string; party_id: string }>).map((s) => [s.id, s.party_id]))
  const invoiceParty = new Map(((invoices.data ?? []) as Array<{ id: string; customer_id: string }>).map((i) => [i.id, customerParty.get(i.customer_id)]).filter((x): x is [string, string] => !!x[1]))
  const entryParty = new Map<string, string>()
  for (const [entryId, src] of entrySource) {
    if (INVOICE_SOURCE_TYPES.has(src.source_type) && src.source_id && invoiceParty.has(src.source_id)) entryParty.set(entryId, invoiceParty.get(src.source_id) as string)
  }
  for (const si of (supplierInvoices.data ?? []) as Array<{ supplier_id: string; registration_journal_entry_id: string | null; payment_journal_entry_id: string | null }>) {
    const party = supplierParty.get(si.supplier_id)
    if (!party) continue
    for (const entryId of [si.registration_journal_entry_id, si.payment_journal_entry_id]) if (entryId) entryParty.set(entryId, party)
  }
  // The bank side: a booked transaction whose counterparty alias names a party ties its verifikat to that party.
  const aliasParty = new Map(((aliases.data ?? []) as Array<{ alias_key: string; party_id: string }>).map((a) => [a.alias_key, a.party_id]))
  const bookedRows = (bookedTx.data ?? []) as Array<{ id: string; journal_entry_id: string | null; original_description: string | null; description: string | null; merchant_name: string | null; date: string }>
  if (bookedRows.length >= TX_CAP) truncated = true
  // Without an alias, a party whose name cleans to the same key as the bank text is the same counterpart;
  // and a bank text with no party at all becomes a merchant node of its own, folded by its key.
  const partyByKey = new Map<string, string>()
  for (const p of partyRows) {
    const key = merchantKey(p.display_name)
    if (key && !partyByKey.has(key)) partyByKey.set(key, p.id)
  }
  const merchants = new Map<string, { label: string; entries: Set<string> }>()
  for (const tx of bookedRows) {
    if (!tx.journal_entry_id || entryParty.has(tx.journal_entry_id)) continue
    let done = false
    for (const raw of [tx.original_description, tx.merchant_name, tx.description]) {
      if (!raw) continue
      const party = aliasParty.get(normalizeCounterpartyName(raw)) ?? partyByKey.get(merchantKey(raw))
      if (party) {
        entryParty.set(tx.journal_entry_id, party)
        if ((entryDate.get(tx.journal_entry_id) ?? '') < tx.date) entryDate.set(tx.journal_entry_id, tx.date)
        done = true
        break
      }
    }
    if (done) continue
    const raw = tx.merchant_name || tx.original_description || tx.description
    const key = merchantKey(raw)
    // A salary transfer or an own withdrawal names a payment, not a payee: the employees and the owner are drawn elsewhere.
    if (!key || isPaymentText(key)) continue
    const m = merchants.get(key) ?? { label: merchantLabel(raw), entries: new Set<string>() }
    m.entries.add(tx.journal_entry_id)
    merchants.set(key, m)
    if ((entryDate.get(tx.journal_entry_id) ?? '') < tx.date) entryDate.set(tx.journal_entry_id, tx.date)
  }
  const partyFlow = new Map<string, number>()
  const partyLast = new Map<string, string>()
  const partyAccountFlow = new Map<string, { amount: number; count: number }>()
  for (const [entryId, party] of entryParty) {
    const per = entryAccounts.get(entryId)
    if (!per) continue
    const when = entryDate.get(entryId)
    if (when && (partyLast.get(party) ?? '') < when) partyLast.set(party, when)
    for (const [account, amount] of per) {
      partyFlow.set(party, (partyFlow.get(party) ?? 0) + amount)
      const key = `${party}|${account}`
      const cur = partyAccountFlow.get(key) ?? { amount: 0, count: 0 }
      partyAccountFlow.set(key, { amount: cur.amount + amount, count: cur.count + 1 })
    }
  }
  const agreementRows = (agreements.data ?? []) as Array<{ id: string; title: string; kind: string; status: string; ends_on: string | null; amount: number | null; period: string | null; principal: number | null; counterparty_party_id: string | null; counterparty_name: string | null; source_document_id: string | null }>
  const referencedParties = new Set(agreementRows.map((a) => a.counterparty_party_id).filter((x): x is string => !!x))
  const documentedParties = new Set(((documentLinks.data ?? []) as unknown as Array<{ target_kind: string; party_id: string | null }>).filter((l) => l.target_kind === 'party').map((l) => l.party_id).filter((x): x is string => !!x))
  const merchantStats = [...merchants].map(([key, m]) => {
    const perAccount = new Map<string, { amount: number; count: number }>()
    let flow = 0
    let last = ''
    for (const entryId of m.entries) {
      const per = entryAccounts.get(entryId)
      if (!per) continue
      const when = entryDate.get(entryId) ?? ''
      if (when > last) last = when
      for (const [account, amount] of per) {
        flow += amount
        const cur = perAccount.get(account) ?? { amount: 0, count: 0 }
        perAccount.set(account, { amount: cur.amount + amount, count: cur.count + 1 })
      }
    }
    return { key, label: m.label, flow, last, entries: m.entries.size, perAccount }
  }).filter((m) => m.flow > 0)
  // Parties and merchants share the same room, ranked by flow; a party an agreement names is always drawn.
  const ranked = [
    ...partyRows.map((p) => ({ party: p.id, merchant: null as string | null, flow: partyFlow.get(p.id) ?? 0, forced: referencedParties.has(p.id) })),
    ...merchantStats.map((m) => ({ party: null as string | null, merchant: m.key, flow: m.flow, forced: false })),
  ].sort((a, b) => b.flow - a.flow)
  const kept = new Set<string>()
  const keptMerchants = new Set<string>()
  for (const c of ranked) {
    if (kept.size + keptMerchants.size >= TOP_PARTIES) break
    if (!(c.flow > 0 || c.forced)) continue
    if (c.party) kept.add(c.party)
    else if (c.merchant) keptMerchants.add(c.merchant)
  }
  for (const p of referencedParties) kept.add(p)
  for (const id of kept) {
    const p = partyById.get(id)
    if (!p) continue
    const lastSeen = partyLast.get(id) ?? null
    add({
      ref: `party:${id}`,
      cluster: 'party',
      kind: 'party',
      label: p.display_name,
      weight: round2(partyFlow.get(id) ?? 0),
      meta: { party_kind: p.kind, flow: round2(partyFlow.get(id) ?? 0), last_seen: lastSeen, active: lastSeen ? lastSeen >= isoDaysAhead(today, -ACTIVE_DAYS) : referencedParties.has(id), documented: documentedParties.has(id) },
    })
  }
  for (const [key, flow] of partyAccountFlow) {
    const [party, account] = key.split('|')
    if (!kept.has(party)) continue
    link(`party:${party}`, `account:${account}`, 'posting', { kind: 'derived', amount: round2(flow.amount), entries: flow.count, source: 'invoices and supplier invoices booked in the period' })
  }
  // Merchants: the bank text is the node until the resolver makes a party of it.
  for (const m of merchantStats.filter((x) => keptMerchants.has(x.key))) {
    const ref = `merchant:${m.key.replace(/[^a-z0-9åäö]+/g, '-')}`
    add({ ref, cluster: 'party', kind: 'merchant', label: m.label, weight: round2(m.flow), meta: { flow: round2(m.flow), last_seen: m.last || null, active: !!m.last && m.last >= isoDaysAhead(today, -ACTIVE_DAYS), documented: false, payments: m.entries, bank_text: m.key } })
    for (const [account, v] of m.perAccount) link(ref, `account:${account}`, 'posting', { kind: 'derived', amount: round2(v.amount), entries: v.count, source: 'bank transactions booked in the period, matched on the bank text' })
  }
  const foldedParties = partyRows.filter((p) => !kept.has(p.id)).length + (merchantStats.length - keptMerchants.size)
  if (foldedParties > 0) {
    add({ ref: 'parties:others', cluster: 'party', kind: 'parties_folded', label: `Övriga motparter, ${foldedParties} st`, weight: foldedParties, meta: { count: foldedParties } })
  }

  // Authorities: static nodes, linked by what they said and what they take.
  add({ ref: 'authority:skatteverket', cluster: 'authority', kind: 'authority', label: 'Skatteverket', weight: 4, meta: {} })
  add({ ref: 'authority:bolagsverket', cluster: 'authority', kind: 'authority', label: 'Bolagsverket', weight: 3, meta: {} })
  for (const account of movement.keys()) {
    if (/^(26|27)\d\d$/.test(account)) link('authority:skatteverket', `account:${account}`, 'posting', { kind: 'derived', movement: round2(movement.get(account) ?? 0) })
  }

  // Agreements, their sources, their counterparties, their obligations.
  const docRows = (documents.data ?? []) as Array<{ id: string; file_name: string; doc_type: string | null; created_at: string; journal_entry_id: string | null }>
  if (docRows.length >= DOC_CAP) truncated = true
  const docById = new Map(docRows.map((d) => [d.id, d]))
  const referencedDocs = new Set<string>()
  for (const a of agreementRows) {
    add({ ref: `agreement:${a.id}`, cluster: 'agreement', kind: 'agreement', label: a.title, weight: Math.max(2, Math.min(12, Math.log10(Math.max(1, Number(a.principal ?? a.amount ?? 0))) * 2)), meta: { agreement_kind: a.kind, status: a.status, ends_on: a.ends_on, amount: a.amount, period: a.period, principal: a.principal } })
    if (a.source_document_id) referencedDocs.add(a.source_document_id)
  }
  const factRows = (facts.data ?? []) as Array<{ id: string; predicate: string; value_text: string; valid_from: string | null; source_document_id: string | null; sources?: Array<Record<string, unknown>> | null }>
  for (const f of factRows) if (f.source_document_id) referencedDocs.add(f.source_document_id)
  const linkRows = (documentLinks.data ?? []) as Array<{ document_id: string; target_kind: string; party_id: string | null; agreement_id: string | null; asset_id: string | null }>
  for (const l of linkRows) referencedDocs.add(l.document_id)
  const groupCounts = new Map<string, { count: number; sample: string[]; entries: string[] }>()
  for (const d of docRows) {
    if (referencedDocs.has(d.id) || (d.doc_type && AUTHORITY_DOC_TYPES[d.doc_type])) {
      add({ ref: `document:${d.id}`, cluster: 'document', kind: 'document', label: d.file_name, weight: 2, meta: { doc_type: d.doc_type, created_at: d.created_at } })
      continue
    }
    const g = group(d.doc_type)
    const cur = groupCounts.get(g) ?? { count: 0, sample: [], entries: [] }
    cur.count++
    if (cur.sample.length < 3) cur.sample.push(d.file_name)
    if (d.journal_entry_id) cur.entries.push(d.journal_entry_id)
    groupCounts.set(g, cur)
  }
  for (const [g, cur] of groupCounts) {
    add({ ref: `documents:${g}`, cluster: 'document', kind: 'documents_folded', label: `${GROUP_LABELS[g] ?? g}, ${cur.count} st`, weight: Math.max(2, Math.log10(cur.count + 1) * 4), meta: { group: g, count: cur.count, sample: cur.sample } })
    // What the folded documents book against: the accounts of their vouchers.
    const perAccount = new Map<string, number>()
    for (const entryId of cur.entries) for (const [account, amount] of entryAccounts.get(entryId) ?? []) perAccount.set(account, (perAccount.get(account) ?? 0) + amount)
    const top = [...perAccount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    for (const [account, amount] of top) link(`documents:${g}`, `account:${account}`, 'posting', { kind: 'aggregate', amount: round2(amount), documents: cur.entries.length })
  }
  for (const a of agreementRows) {
    if (a.counterparty_party_id) link(`agreement:${a.id}`, `party:${a.counterparty_party_id}`, 'party', { kind: 'fk' })
    if (a.source_document_id) link(`agreement:${a.id}`, `document:${a.source_document_id}`, 'source', { kind: 'fk' })
  }
  const factRules = new Map<string, (typeof FACT_RULES)[string]>()
  for (const f of factRows) {
    add({ ref: `fact:${f.id}`, cluster: 'fact', kind: 'fact', label: `${f.predicate}: ${f.value_text.slice(0, 60)}`, weight: 2, meta: { predicate: f.predicate, value: f.value_text.slice(0, 200), valid_from: f.valid_from } })
    if (f.source_document_id) {
      link(`fact:${f.id}`, `document:${f.source_document_id}`, 'source', { kind: 'fk' })
      const authority = AUTHORITY_DOC_TYPES[docById.get(f.source_document_id)?.doc_type ?? '']
      if (authority) link(`authority:${authority}`, `fact:${f.id}`, 'authority', { kind: 'derived', via: 'source document type' })
    }
    // A registration is not just a fact about the company: it is why certain accounts move and certain deadlines exist.
    const rule = FACT_RULES[f.predicate]
    if (rule) {
      link(`authority:${rule.authority}`, `fact:${f.id}`, 'authority', { kind: 'rule', via: rule.why })
      for (const account of movement.keys()) if (rule.accounts?.test(account)) link(`fact:${f.id}`, `account:${account}`, 'link', { kind: 'rule', via: rule.why, movement: round2(movement.get(account) ?? 0) })
      factRules.set(f.id, rule)
    }
    // A fact read off the ledger points back at the accounts and the counterparty it was read from:
    // the evidence a derive records is the fact's source row (record_company_fact stores it in sources).
    const ledger = LEDGER_FACT_RULES[f.predicate]
    if (ledger) {
      for (const account of movement.keys()) if (ledger.accounts?.test(account)) link(`fact:${f.id}`, `account:${account}`, 'link', { kind: 'derived', via: ledger.why, movement: round2(movement.get(account) ?? 0) })
      for (const source of f.sources ?? []) {
        for (const account of evidenceAccounts(source)) link(`fact:${f.id}`, `account:${account}`, 'link', { kind: 'derived', via: ledger.why })
        if (typeof source?.node === 'string') link(`fact:${f.id}`, source.node, 'link', { kind: 'derived', via: ledger.why })
      }
    }
  }
  for (const d of docRows) {
    const authority = d.doc_type ? AUTHORITY_DOC_TYPES[d.doc_type] : undefined
    if (authority) link(`authority:${authority}`, `document:${d.id}`, 'authority', { kind: 'derived', via: 'document type' })
  }
  for (const l of linkRows) {
    if (l.target_kind === 'party' && l.party_id) link(`document:${l.document_id}`, `party:${l.party_id}`, 'link', { kind: 'fk' })
    if (l.target_kind === 'agreement' && l.agreement_id) link(`document:${l.document_id}`, `agreement:${l.agreement_id}`, 'link', { kind: 'fk' })
  }

  // Obligations: matched ones tie an agreement to the accounts that paid; expected ones within ninety days are upcoming.
  const txEntry = new Map(((transactions.data ?? []) as Array<{ id: string; journal_entry_id: string | null }>).map((t) => [t.id, t.journal_entry_id]))
  const obligationRows = (obligations.data ?? []) as Array<{ id: string; agreement_id: string; kind: string; due_on: string; amount: number; status: string; transaction_id: string | null; direction: string | null }>
  const matchedByAgreementAccount = new Map<string, { amount: number; count: number }>()
  for (const o of obligationRows) {
    if (o.status === 'matched' && o.transaction_id) {
      const entryId = txEntry.get(o.transaction_id)
      const per = entryId ? entryAccounts.get(entryId) : undefined
      if (per) for (const [account, amount] of per) {
        const key = `${o.agreement_id}|${account}`
        const cur = matchedByAgreementAccount.get(key) ?? { amount: 0, count: 0 }
        matchedByAgreementAccount.set(key, { amount: cur.amount + amount, count: cur.count + 1 })
      }
    }
    if (o.status === 'expected' && o.due_on >= today) {
      add({ ref: `obligation:${o.id}`, cluster: 'upcoming', kind: 'obligation', label: `${o.kind} ${o.due_on}, ${kr(Number(o.amount))} kr`, weight: 2, meta: { due_on: o.due_on, amount: Number(o.amount), obligation_kind: o.kind, direction: o.direction } })
      link(`agreement:${o.agreement_id}`, `obligation:${o.id}`, 'upcoming', { kind: 'fk' })
    }
  }
  for (const [key, m] of matchedByAgreementAccount) {
    const [agreementId, account] = key.split('|')
    link(`agreement:${agreementId}`, `account:${account}`, 'matched', { kind: 'match', amount: round2(m.amount), payments: m.count })
  }

  // People: the payroll, with owners and board marked; the salary account is what ties them to the books.
  const employeeRows = ((employees.data ?? []) as Array<{ id: string; first_name: string; last_name: string; employment_type: string; employment_end: string | null }>).filter((e) => !e.employment_end || e.employment_end >= today)
  // Which verifikat each salary run booked: the run is the source of its salary, employer-contribution, pension and vacation entries.
  const runEntries = new Map<string, string[]>()
  for (const [entryId, src] of entrySource) {
    if (src.source_type === 'salary_payment' && src.source_id) runEntries.set(src.source_id, [...(runEntries.get(src.source_id) ?? []), entryId])
  }
  const personAccount = new Map<string, { amount: number; runs: Set<string> }>()
  for (const r of (runEmployees.data ?? []) as Array<{ salary_run_id: string; employee_id: string; gross_salary: number | string | null }>) {
    for (const entryId of runEntries.get(r.salary_run_id) ?? []) {
      for (const account of entryAccounts.get(entryId)?.keys() ?? []) {
        if (!/^7\d\d\d$/.test(account)) continue
        const key = `${r.employee_id}|${account}`
        const cur = personAccount.get(key) ?? { amount: 0, runs: new Set<string>() }
        if (!cur.runs.has(r.salary_run_id)) cur.amount += Number(r.gross_salary ?? 0)
        cur.runs.add(r.salary_run_id)
        personAccount.set(key, cur)
      }
    }
  }
  for (const e of employeeRows) {
    add({ ref: `person:${e.id}`, cluster: 'person', kind: 'person', label: `${e.first_name} ${e.last_name}`.trim(), weight: 2, meta: { role: e.employment_type } })
    let tied = false
    for (const [key, v] of personAccount) {
      const [employee, account] = key.split('|')
      if (employee !== e.id) continue
      link(`person:${e.id}`, `account:${account}`, 'role', { kind: 'derived', amount: round2(v.amount), payments: v.runs.size, source: 'salary runs booked in the period' })
      tied = true
    }
    if (!tied && movement.has('7010') && e.employment_type === 'employee') link(`person:${e.id}`, 'account:7010', 'role', { kind: 'derived', via: 'salary account has movement' })
  }

  // Deadlines and what the books say is missing.
  for (const d of (deadlines.data ?? []) as Array<{ id: string; title: string; due_date: string; deadline_type: string; tax_deadline_type?: string | null; status: string }>) {
    add({ ref: `deadline:${d.id}`, cluster: 'upcoming', kind: 'deadline', label: `${d.title}, ${d.due_date}`, weight: 2, meta: { due_date: d.due_date, deadline_type: d.deadline_type, tax_deadline_type: d.tax_deadline_type ?? null, status: d.status } })
    link(/bolagsverket|annual|arsredovisning/i.test(d.deadline_type) ? 'authority:bolagsverket' : 'authority:skatteverket', `deadline:${d.id}`, 'authority', { kind: 'derived', via: 'deadline type' })
    const kindText = `${d.deadline_type} ${d.tax_deadline_type ?? ''} ${d.title}`
    for (const [factId, rule] of factRules) if (rule.deadlines?.test(kindText)) link(`fact:${factId}`, `deadline:${d.id}`, 'upcoming', { kind: 'rule', via: rule.why })
  }
  for (const x of (expected.data ?? []) as Array<{ id: string; detail: Record<string, unknown> }>) {
    const rule = String(x.detail.rule ?? 'document')
    add({ ref: `expected:${x.id}`, cluster: 'agreement', kind: 'expected', label: `Saknas: ${String(x.detail.expected_type ?? rule)}`, weight: 3, meta: { rule, expected_type: x.detail.expected_type ?? null, evidence: x.detail.evidence ?? null, missing: true } })
    for (const account of ((x.detail.evidence as { accounts?: string[] } | undefined)?.accounts ?? [])) link(`expected:${x.id}`, `account:${account}`, 'expected', { kind: 'derived', via: 'the evidence behind the request' })
  }

  const all = [...nodes.values()]
  const clusters = (Object.keys(CLUSTER_LABELS) as ClusterId[]).map((id) => ({ id, label: CLUSTER_LABELS[id], count: all.filter((n) => n.cluster === id).length }))
  return {
    company: { ref: `company:${companyId}`, name: (company.data as { name: string } | null)?.name ?? '' },
    version: GRAPH_VERSION,
    computed_at: new Date().toISOString(),
    period: { from, to: today },
    months,
    series,
    clusters,
    nodes: all,
    links,
    truncated,
  }
}
