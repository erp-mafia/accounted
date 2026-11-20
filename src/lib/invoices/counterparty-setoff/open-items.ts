/**
 * A counterparty that is both customer and supplier, as one relation: every
 * customer and supplier card of the party, the open customer invoices (what
 * they owe us), the open supplier invoices (what we owe them), the net per
 * currency and the set-offs between them. Each open invoice says whether it
 * can be set off now, and why not when it cannot (./plan.ts).
 *
 * Credit notes are left out: they settle their own invoice through the
 * credit flow, never by a set-off, so the net here is the net of the open
 * invoices, not the whole reskontra balance.
 */
import { filterOwedInvoices } from '@/lib/invoices/overdue'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { customerInvoiceIneligibility, supplierInvoiceIneligibility, type SetoffIneligibleReason } from './plan'
import {
  openCollectionInvoiceIds,
  paymentInFlightSupplierInvoiceIds,
  resolveCanonicalParties,
  toSetoffInvoiceFacts,
  toSetoffSupplierInvoiceFacts,
  type SetoffInvoiceRow,
  type SetoffSupplierInvoiceRow,
} from './state'

export type CounterpartyRef = { partyId: string } | { customerId: string } | { supplierId: string }

export interface CounterpartyReceivable {
  invoice_id: string
  customer_id: string | null
  number: string | null
  invoice_date: string
  due_date: string | null
  currency: string
  total: number
  remaining_amount: number
  status: string
  setoff_eligible: boolean
  ineligible_reason: SetoffIneligibleReason | null
}

export interface CounterpartyPayable {
  supplier_invoice_id: string
  supplier_id: string | null
  number: string | null
  arrival_number: number | null
  invoice_date: string
  due_date: string | null
  currency: string
  total: number
  remaining_amount: number
  status: string
  setoff_eligible: boolean
  ineligible_reason: SetoffIneligibleReason | null
}

export interface CounterpartyTotal {
  currency: string
  /** What they owe us. */
  receivable: number
  /** What we owe them. */
  payable: number
  /** receivable - payable: above zero they pay us, below zero we pay them. */
  net: number
  direction: 'they_pay' | 'we_pay' | 'settled'
}

export interface CounterpartySetoffRow {
  setoff_id: string
  setoff_date: string
  amount: number
  status: 'booked' | 'reversed'
  invoice_id: string
  supplier_invoice_id: string
  journal_entry_id: string
  note: string | null
}

export interface CounterpartyBalance {
  party: { party_id: string; name: string; org_number: string | null }
  customers: Array<{ customer_id: string; name: string }>
  suppliers: Array<{ supplier_id: string; name: string }>
  receivables: CounterpartyReceivable[]
  payables: CounterpartyPayable[]
  totals: CounterpartyTotal[]
  setoffs: CounterpartySetoffRow[]
}

const OPEN_SUPPLIER_INVOICE_STATUSES = ['registered', 'approved', 'overdue', 'partially_paid'] as const
/** Rows read per side: a counterparty with more open invoices than this is not a set-off case. */
const OPEN_ITEM_LIMIT = 500
const SETOFF_HISTORY_LIMIT = 50

function fail(message: string, error: { message: string }): never {
  throw new Error(`counterparty balance: ${message}: ${error.message}`)
}

/** The canonical party a reference points at, or null when it has none. */
async function canonicalPartyFor(supabase: SupabaseClient, companyId: string, ref: CounterpartyRef): Promise<string | null> {
  let partyId: string | null = null
  if ('partyId' in ref) {
    partyId = ref.partyId
  } else if ('customerId' in ref) {
    const { data, error } = await supabase.from('customers').select('party_id').eq('company_id', companyId).eq('id', ref.customerId).maybeSingle()
    if (error) fail('customer lookup failed', error)
    partyId = (data as { party_id: string | null } | null)?.party_id ?? null
  } else {
    const { data, error } = await supabase.from('suppliers').select('party_id').eq('company_id', companyId).eq('id', ref.supplierId).maybeSingle()
    if (error) fail('supplier lookup failed', error)
    partyId = (data as { party_id: string | null } | null)?.party_id ?? null
  }
  if (!partyId) return null
  const canonical = await resolveCanonicalParties(supabase, companyId, [partyId])
  return canonical.get(partyId) ?? null
}

/** The longest merged_into chain followed, as canonical_party_id does. */
const MAX_MERGE_DEPTH = 16

/**
 * The party and every party merged into it, directly or through another
 * merge: the ids a card of this counterparty can point at.
 */
async function memberPartyIds(supabase: SupabaseClient, companyId: string, canonicalId: string): Promise<string[]> {
  const members = new Set([canonicalId])
  let frontier = [canonicalId]
  for (let depth = 0; depth < MAX_MERGE_DEPTH && frontier.length > 0; depth++) {
    const { data, error } = await supabase
      .from('parties')
      .select('id')
      .eq('company_id', companyId)
      .in('merged_into', frontier)
    if (error) fail('merged party lookup failed', error)
    frontier = ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => !members.has(id))
    for (const id of frontier) members.add(id)
  }
  return [...members]
}

function totalsByCurrency(receivables: CounterpartyReceivable[], payables: CounterpartyPayable[]): CounterpartyTotal[] {
  const byCurrency = new Map<string, { receivable: number; payable: number }>()
  const bucket = (currency: string) => {
    const existing = byCurrency.get(currency)
    if (existing) return existing
    const created = { receivable: 0, payable: 0 }
    byCurrency.set(currency, created)
    return created
  }
  for (const r of receivables) bucket(r.currency).receivable += r.remaining_amount
  for (const p of payables) bucket(p.currency).payable += p.remaining_amount
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, sums]) => {
      const receivable = roundOre(sums.receivable)
      const payable = roundOre(sums.payable)
      const net = roundOre(receivable - payable)
      return { currency, receivable, payable, net, direction: net > 0 ? 'they_pay' : net < 0 ? 'we_pay' : 'settled' }
    })
}

/**
 * The counterparty's balance, or null when the reference has no party (a
 * card without an org number that was never linked to one). Throws on a
 * failed read.
 */
export async function loadCounterpartyBalance(
  supabase: SupabaseClient,
  companyId: string,
  ref: CounterpartyRef,
): Promise<CounterpartyBalance | null> {
  const partyId = await canonicalPartyFor(supabase, companyId, ref)
  if (!partyId) return null

  const [partyRes, members] = await Promise.all([
    supabase.from('parties').select('id, display_name, legal_name, org_number').eq('company_id', companyId).eq('id', partyId).maybeSingle(),
    memberPartyIds(supabase, companyId, partyId),
  ])
  if (partyRes.error) fail('party lookup failed', partyRes.error)
  if (!partyRes.data) return null
  const party = partyRes.data as { id: string; display_name: string; legal_name: string | null; org_number: string | null }

  const [customersRes, suppliersRes, setoffsRes] = await Promise.all([
    supabase.from('customers').select('id, name').eq('company_id', companyId).in('party_id', members).order('created_at'),
    supabase.from('suppliers').select('id, name').eq('company_id', companyId).in('party_id', members).order('created_at'),
    supabase
      .from('counterparty_setoffs')
      .select('id, setoff_date, amount, status, invoice_id, supplier_invoice_id, journal_entry_id, note')
      .eq('company_id', companyId)
      .in('party_id', members)
      .order('setoff_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(SETOFF_HISTORY_LIMIT),
  ])
  if (customersRes.error) fail('customer cards lookup failed', customersRes.error)
  if (suppliersRes.error) fail('supplier cards lookup failed', suppliersRes.error)
  if (setoffsRes.error) fail('set-off lookup failed', setoffsRes.error)
  const customers = (customersRes.data ?? []) as Array<{ id: string; name: string }>
  const suppliers = (suppliersRes.data ?? []) as Array<{ id: string; name: string }>

  const [invoicesRes, supplierInvoicesRes] = await Promise.all([
    customers.length === 0
      ? Promise.resolve({ data: [], error: null })
      : filterOwedInvoices(
          supabase
            .from('invoices')
            .select(
              'id, invoice_number, external_invoice_number, status, document_type, credited_invoice_id, currency, total, remaining_amount, paid_amount, deduction_total, invoice_date, due_date, journal_entry_id, customer_id',
            )
            .eq('company_id', companyId)
            .in('customer_id', customers.map((c) => c.id)),
        )
          .order('invoice_date')
          .limit(OPEN_ITEM_LIMIT),
    suppliers.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from('supplier_invoices')
          .select(
            'id, supplier_invoice_number, arrival_number, status, is_credit_note, currency, total, remaining_amount, paid_amount, invoice_date, due_date, registration_journal_entry_id, bank_entered_at, supplier_id',
          )
          .eq('company_id', companyId)
          .in('supplier_id', suppliers.map((s) => s.id))
          .eq('is_credit_note', false)
          .in('status', [...OPEN_SUPPLIER_INVOICE_STATUSES])
          .gt('remaining_amount', 0)
          .order('invoice_date')
          .limit(OPEN_ITEM_LIMIT),
  ])
  if (invoicesRes.error) fail('open invoice lookup failed', invoicesRes.error)
  if (supplierInvoicesRes.error) fail('open supplier invoice lookup failed', supplierInvoicesRes.error)
  const invoiceRows = (invoicesRes.data ?? []) as unknown as SetoffInvoiceRow[]
  const supplierRows = (supplierInvoicesRes.data ?? []) as unknown as SetoffSupplierInvoiceRow[]

  const [collections, inFlight] = await Promise.all([
    openCollectionInvoiceIds(supabase, companyId, invoiceRows.map((r) => r.id)),
    paymentInFlightSupplierInvoiceIds(supabase, companyId, supplierRows),
  ])

  const receivables: CounterpartyReceivable[] = invoiceRows.map((row) => {
    const facts = toSetoffInvoiceFacts(row, { partyId, collectionOpen: collections.has(row.id) })
    const reason = customerInvoiceIneligibility(facts)
    return {
      invoice_id: row.id,
      customer_id: row.customer_id,
      number: facts.number,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      currency: row.currency ?? 'SEK',
      total: facts.total,
      remaining_amount: roundOre(facts.remaining),
      status: row.status,
      setoff_eligible: reason === null,
      ineligible_reason: reason,
    }
  })
  const payables: CounterpartyPayable[] = supplierRows.map((row) => {
    const facts = toSetoffSupplierInvoiceFacts(row, { partyId, paymentInFlight: inFlight.has(row.id) })
    const reason = supplierInvoiceIneligibility(facts)
    return {
      supplier_invoice_id: row.id,
      supplier_id: row.supplier_id,
      number: row.supplier_invoice_number,
      arrival_number: row.arrival_number,
      invoice_date: row.invoice_date,
      due_date: row.due_date,
      currency: row.currency ?? 'SEK',
      total: facts.total,
      remaining_amount: roundOre(facts.remaining),
      status: row.status,
      setoff_eligible: reason === null,
      ineligible_reason: reason,
    }
  })

  return {
    party: { party_id: party.id, name: party.legal_name ?? party.display_name, org_number: party.org_number },
    customers: customers.map((c) => ({ customer_id: c.id, name: c.name })),
    suppliers: suppliers.map((s) => ({ supplier_id: s.id, name: s.name })),
    receivables,
    payables,
    totals: totalsByCurrency(receivables, payables),
    setoffs: ((setoffsRes.data ?? []) as Array<CounterpartySetoffRow & { id: string; amount: number | string }>).map((s) => ({
      setoff_id: s.id,
      setoff_date: s.setoff_date,
      amount: Number(s.amount),
      status: s.status,
      invoice_id: s.invoice_id,
      supplier_invoice_id: s.supplier_invoice_id,
      journal_entry_id: s.journal_entry_id,
      note: s.note,
    })),
  }
}
