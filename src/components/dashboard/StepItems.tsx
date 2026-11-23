'use client'

import { useContext, useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LIST_BLEED_CLASS, QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { createClient } from '@/lib/supabase/client'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { filterOverdueInvoices } from '@/lib/invoices/overdue'
import { isAwaitingAttestInList, isToPayInList, type ListTabInvoice } from '@/lib/supplier-invoices/list-tabs'
import { cn, formatDate } from '@/lib/utils'
import { amountText } from './att-gora-views'
import { StepSummarySink } from './need-count'
import { DoorMark, useDoorName } from '@/components/inkorg/door-icon'
import { doorOf, itemHeadline, queueFor, type InkorgItem } from '@/lib/inkorg/items'
import type { IntakeSourceId } from '@/lib/intake/sources'
import { INKORG_FOCUS_QUERY, INKORG_HREF } from '@/lib/inkorg/flag'
import { PAYMENT_STATUSES_TO_BOOK, SETTLEMENT_STATUSES_TO_BOOK } from '@/lib/collections/settlements-ui'
import { filterOpenDeadlines } from '@/lib/deadlines/open'
import { readSkattekontoOpeningDate, whereSkattekontoRowOpen } from '@/lib/skatteverket/skattekonto-open-rows'
import { bookingScreenHref } from '@/lib/bookkeeping/booking-screen'

/**
 * What stands behind a count row, inside its Börja step: the first few items
 * (name, date, amount, each opening the item) and "Visa alla N" to the page
 * the row leads to. Read-only, one bounded read per kind, through the read
 * the destination page makes or the predicate its count is defined by
 * (lib/worklist/categories.ts), never a new route:
 *
 *   attest              GET /api/supplier-invoices?status=unsettled, narrowed with
 *                       the Registrerade rule (lib/supplier-invoices/list-tabs)
 *   to_pay              GET /api/supplier-invoices?status=to_pay (the Att betala tab)
 *   overdue             invoices, the Förfallna rule (lib/invoices/overdue)
 *   missing_underlag    GET /api/bookkeeping/journal-entries?missing_underlag=true
 *   inbox               GET /api/extensions/ext/invoice-inbox/items?limit=200, the
 *                       read Inkommande makes, in its Behöver dig queue order
 *   bank_rows, matches  transactions not yet booked (and with a proposed match)
 *   to_book             the same bank rows, each opening the booking screen
 *                       (Att bokföra's row, with the booking screen switched on)
 *   skattekonto         skattekonto_transactions booked at Skatteverket, no verifikat
 *   settlements, collected_payments, collection_decision, collection_attention
 *                       the collection tables, by the statuses the counts use
 *   held_documents, unclassified, field_review
 *                       the arkiv tables, by the predicates the counts use
 *   peppol_failed       the peppol_failed_invoice_ids RPC, then those invoices
 *   deadlines           open deadlines that need action or are overdue
 *   agreement_missed    agreement_obligations with status missed
 *   given               rows the page already holds (a batch, the bank consents)
 *
 * Every table read goes through the session client (RLS) with the company
 * filter and a limit of STEP_ITEMS_CAP, oldest or soonest first.
 */

export type StepItemsKind =
  | 'attest'
  | 'to_pay'
  | 'overdue'
  | 'missing_underlag'
  | 'inbox'
  | 'bank_rows'
  | 'to_book'
  | 'matches'
  | 'skattekonto'
  | 'settlements'
  | 'collected_payments'
  | 'collection_decision'
  | 'collection_attention'
  | 'held_documents'
  | 'unclassified'
  | 'field_review'
  | 'peppol_failed'
  | 'deadlines'
  | 'agreement_missed'
  | 'given'

export const STEP_ITEMS_CAP = 8

/** The window the unclassified-documents count looks back over (lib/worklist/categories REVIEW_RECENT_DAYS). */
const REVIEW_RECENT_DAYS = 60

/** How many inbox items the step asks Inkommande's read for: the newest, which hold every open one of an ordinary inbox. */
const INBOX_READ_LIMIT = 200

export interface StepItem {
  id: string
  name: string
  date: string | null
  amount: number | null
  currency: string | null
  href: string
  /** An inbox document: the door it came through. */
  door?: IntakeSourceId
}

/** What a step's table tells the step's fields: the earliest date, and the sum when every item is listed. */
export interface StepItemsSummary {
  earliest: string | null
  sum: { value: number; currency: string | null } | null
}

export type SupplierInvoiceRow = ListTabInvoice & {
  id: string
  supplier?: { name?: string | null } | null
  supplier_invoice_number?: string | null
  arrival_number?: number | null
  total?: number | null
  currency?: string | null
}

/** A supplier invoice as a step item: the supplier and its invoice number, what is left to pay, the due date. */
export function supplierInvoiceItem(row: SupplierInvoiceRow): StepItem {
  const number = row.supplier_invoice_number?.trim() || (row.arrival_number != null ? `#${row.arrival_number}` : '')
  return {
    id: row.id,
    name: [row.supplier?.name?.trim(), number].filter(Boolean).join(' · '),
    date: row.due_date ?? null,
    amount: row.remaining_amount ?? row.total ?? null,
    currency: row.currency ?? null,
    href: `/supplier-invoices/${row.id}`,
  }
}

/** Soonest first; a row without a date last. */
export function byDate(a: StepItem, b: StepItem): number {
  if (a.date === b.date) return 0
  if (!a.date) return 1
  if (!b.date) return -1
  return a.date < b.date ? -1 : 1
}

async function loadSupplierInvoices(kind: 'attest' | 'to_pay'): Promise<StepItem[]> {
  // Att betala is asked for as the tab asks (the route narrows it); Registrerade
  // reads what is not settled, since an invoice to attest never is.
  const res = await fetch(`/api/supplier-invoices?status=${kind === 'to_pay' ? 'to_pay' : 'unsettled'}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const rows = ((await res.json()).data ?? []) as SupplierInvoiceRow[]
  return rows.filter(kind === 'attest' ? isAwaitingAttestInList : isToPayInList).map(supplierInvoiceItem).sort(byDate)
}

async function loadMissingUnderlag(): Promise<StepItem[]> {
  const res = await fetch(`/api/bookkeeping/journal-entries?missing_underlag=true&limit=${STEP_ITEMS_CAP}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const rows = ((await res.json()).data ?? []) as Array<{
    id: string
    voucher_series: string | null
    voucher_number: number | null
    entry_date: string
    description: string | null
  }>
  return rows.map((row) => ({
    id: row.id,
    name: [row.voucher_number != null ? formatVoucher(row) : null, row.description].filter(Boolean).join(' · '),
    date: row.entry_date,
    amount: null,
    currency: null,
    href: `/bookkeeping/${row.id}`,
  }))
}

async function loadOverdueInvoices(companyId: string): Promise<StepItem[]> {
  const supabase = createClient()
  const { data, error } = await filterOverdueInvoices(
    supabase
      .from('invoices')
      .select('id, invoice_number, due_date, remaining_amount, total, currency, customer:customers(name)')
      .eq('company_id', companyId),
  )
    .order('due_date', { ascending: true })
    .limit(STEP_ITEMS_CAP)
  if (error) throw new Error(error.message)
  type Row = {
    id: string
    invoice_number: string | null
    due_date: string | null
    remaining_amount: number | null
    total: number | null
    currency: string | null
    customer: { name: string | null } | { name: string | null }[] | null
  }
  return ((data ?? []) as Row[]).map((row) => {
    const customer = Array.isArray(row.customer) ? row.customer[0] : row.customer
    return {
      id: row.id,
      name: [customer?.name, row.invoice_number].filter(Boolean).join(' · '),
      date: row.due_date,
      amount: row.remaining_amount ?? row.total,
      currency: row.currency,
      href: `/invoices/${row.id}`,
    }
  })
}

/** The Inkommande address that opens one document in its focus view (InkorgPage reads `fokus`). */
export function inboxFocusHref(href: string, id: string): string {
  return href === INKORG_HREF ? `${INKORG_HREF}?${INKORG_FOCUS_QUERY}=${encodeURIComponent(id)}` : href
}

/** An inbox item as a step item: what it is, the door it came through, when it came in, the amount read off it. */
export function inboxStepItem(item: InkorgItem, href: string): StepItem {
  const head = itemHeadline(item)
  return {
    id: item.id,
    name: head.name ?? item.email_from?.trim() ?? '',
    date: item.created_at,
    amount: head.amount,
    currency: head.amount == null ? null : head.currency,
    href: inboxFocusHref(href, item.id),
    door: doorOf(item),
  }
}

async function loadInbox(href: string): Promise<StepItem[]> {
  const res = await fetch(`/api/extensions/ext/invoice-inbox/items?limit=${INBOX_READ_LIMIT}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { items?: InkorgItem[] } }
  // Behöver dig, in the order Inkommande walks it: the step's first row is the one the primary opens.
  return queueFor(json.data?.items ?? [], { kind: 'need' }).map((item) => inboxStepItem(item, href))
}

type Row = Record<string, unknown>
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}
const one = (value: unknown): Row | null => (Array.isArray(value) ? ((value[0] as Row | undefined) ?? null) : ((value as Row | null) ?? null))
const joined = (...parts: unknown[]): string => parts.map(text).filter(Boolean).join(' · ')

/** An invoice embedded in a row (its number and its customer). */
const invoiceName = (invoice: unknown): string => {
  const inv = one(invoice)
  return joined(one(inv?.customer)?.name, inv?.invoice_number)
}

/**
 * The table reads, one per kind: the predicate is the count's own
 * (lib/worklist/categories.ts), the order oldest or soonest first, the limit
 * STEP_ITEMS_CAP.
 */
/**
 * The page a booking screen opened from a step returns to: the view the step
 * was opened in, Börja on its step included, so the person goes on from the
 * same place (safeReturnPath keeps any view of Hem).
 */
function stepBack(): string {
  return `${window.location.pathname}${window.location.search}`
}

async function loadFromTables(kind: StepItemsKind, companyId: string, href: string): Promise<StepItem[]> {
  const supabase = createClient()
  const rows = async (query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> => {
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return (data ?? []) as Row[]
  }
  switch (kind) {
    case 'bank_rows':
    case 'to_book':
    case 'matches': {
      let query = supabase
        .from('transactions')
        .select('id, date, description, amount, currency')
        .eq('company_id', companyId)
        .is('is_business', null)
        .eq('is_ignored', false)
      if (kind === 'matches') {
        query = query.or('potential_invoice_id.not.is.null,potential_supplier_invoice_id.not.is.null,potential_rot_rut_payout_request_id.not.is.null')
      }
      return (await rows(query.order('date', { ascending: true }).order('id', { ascending: true }).limit(STEP_ITEMS_CAP))).map((r) => ({
        id: String(r.id),
        name: text(r.description),
        date: text(r.date) || null,
        amount: num(r.amount),
        currency: text(r.currency) || null,
        href:
          kind === 'to_book'
            ? bookingScreenHref({ kind: 'transaction', transactionId: String(r.id), account: null }, stepBack())
            : `/transactions?highlight=${r.id}`,
      }))
    }
    case 'skattekonto': {
      // The count's own reading: a row before the IB on the skattekonto
      // account is carried by it, so it is never listed as work. An IB that
      // cannot be read lists every open row, as the count does.
      const openingDate = await readSkattekontoOpeningDate(supabase, companyId).catch((err: unknown) => {
        console.warn('[StepItems] skattekonto opening balance read failed; listing every open row', err)
        return null
      })
      return (
        await rows(
          whereSkattekontoRowOpen(
            supabase
              .from('skattekonto_transactions')
              .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket')
              .eq('company_id', companyId),
            openingDate,
          )
            .order('transaktionsdatum', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({ id: String(r.id), name: text(r.transaktionstext), date: text(r.transaktionsdatum) || null, amount: num(r.belopp_skatteverket), currency: null, href }))
    }
    case 'settlements':
      return (
        await rows(
          supabase
            .from('collection_settlements')
            .select('id, payment_date, bank_reference, provider_settlement_ref, amount, currency')
            .eq('company_id', companyId)
            .in('status', [...SETTLEMENT_STATUSES_TO_BOOK])
            .order('payment_date', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({
        id: String(r.id),
        name: text(r.bank_reference) || text(r.provider_settlement_ref),
        date: text(r.payment_date) || null,
        amount: num(r.amount),
        currency: text(r.currency) || null,
        href: `/invoices/settlements?settlement=${r.id}`,
      }))
    case 'collected_payments':
      return (
        await rows(
          supabase
            .from('collection_collected_payments')
            .select('id, paid_at, provider_payment_ref, total, invoice:invoices(invoice_number, customer:customers(name))')
            .eq('company_id', companyId)
            .in('status', [...PAYMENT_STATUSES_TO_BOOK])
            .order('paid_at', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({
        id: String(r.id),
        name: invoiceName(r.invoice) || text(r.provider_payment_ref),
        date: text(r.paid_at) || null,
        amount: num(r.total),
        currency: null,
        href: `/invoices/settlements?payment=${r.id}`,
      }))
    case 'collection_decision':
    case 'collection_attention': {
      let query = supabase
        .from('collection_cases')
        .select('id, invoice_id, next_action_date, outstanding_total, currency, provider_case_number, invoice:invoices(invoice_number, customer:customers(name))')
        .eq('company_id', companyId)
      if (kind === 'collection_decision') {
        query = query.eq('is_open', true).eq('stage', 'awaiting_decision')
      } else {
        const { data: ids, error } = await supabase.rpc('collection_attention_case_ids', { p_company_id: companyId })
        if (error) throw new Error(error.message)
        const caseIds = (Array.isArray(ids) ? ids : []).map((id) => (typeof id === 'string' ? id : String((id as Row)?.id ?? ''))).filter(Boolean)
        if (caseIds.length === 0) return []
        query = query.in('id', caseIds.slice(0, 100))
      }
      return (await rows(query.order('next_action_date', { ascending: true, nullsFirst: false }).limit(STEP_ITEMS_CAP))).map((r) => ({
        id: String(r.id),
        name: invoiceName(r.invoice) || text(r.provider_case_number),
        date: text(r.next_action_date) || null,
        amount: num(r.outstanding_total),
        currency: text(r.currency) || null,
        href: r.invoice_id ? `/invoices/${r.invoice_id}` : href,
      }))
    }
    case 'held_documents':
      return (
        await rows(
          supabase
            .from('document_attachments')
            .select('id, file_name, created_at')
            .eq('company_id', companyId)
            .eq('admission_state', 'held')
            .order('created_at', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({ id: String(r.id), name: text(r.file_name), date: text(r.created_at) || null, amount: null, currency: null, href: `/arkiv/dokument/${r.id}` }))
    case 'unclassified':
      return (
        await rows(
          supabase
            .from('document_classifications')
            .select('id, document_id, created_at, document_attachments!inner(file_name, created_at, journal_entry_id, journal_entry_line_id)')
            .eq('company_id', companyId)
            .eq('is_current', true)
            .eq('decided_by', 'model')
            .eq('relevance', 'relevant')
            .or('doc_type.eq.other,confidence.lt.0.6')
            .gte('document_attachments.created_at', new Date(Date.now() - REVIEW_RECENT_DAYS * 86_400_000).toISOString())
            .is('document_attachments.journal_entry_id', null)
            .is('document_attachments.journal_entry_line_id', null)
            .order('created_at', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => {
        const doc = one(r.document_attachments)
        return { id: String(r.id), name: text(doc?.file_name), date: text(doc?.created_at) || text(r.created_at) || null, amount: null, currency: null, href }
      })
    case 'field_review':
      return (
        await rows(
          supabase
            .from('document_extractions')
            .select('id, document_id, created_at, document:document_attachments(file_name)')
            .eq('company_id', companyId)
            .eq('is_current', true)
            .not('review_fields', 'eq', '{}')
            .order('created_at', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({ id: String(r.id), name: text(one(r.document)?.file_name), date: text(r.created_at) || null, amount: null, currency: null, href }))
    case 'peppol_failed': {
      const { data: ids, error } = await supabase.rpc('peppol_failed_invoice_ids', { p_company_id: companyId, p_limit: STEP_ITEMS_CAP })
      if (error) throw new Error(error.message)
      const invoiceIds = ((ids ?? []) as unknown[]).filter((id): id is string => typeof id === 'string')
      if (invoiceIds.length === 0) return []
      return (
        await rows(
          supabase
            .from('invoices')
            .select('id, invoice_number, invoice_date, total, currency, customer:customers(name)')
            .eq('company_id', companyId)
            .in('id', invoiceIds)
            .order('invoice_date', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({
        id: String(r.id),
        name: joined(one(r.customer)?.name, r.invoice_number),
        date: text(r.invoice_date) || null,
        amount: num(r.total),
        currency: text(r.currency) || null,
        href: `/invoices/${r.id}`,
      }))
    }
    case 'deadlines':
      return (
        await rows(
          filterOpenDeadlines(supabase.from('deadlines').select('id, title, due_date').eq('company_id', companyId))
            .in('status', ['action_needed', 'overdue'])
            .order('due_date', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => ({ id: String(r.id), name: text(r.title), date: text(r.due_date) || null, amount: null, currency: null, href }))
    case 'agreement_missed':
      return (
        await rows(
          supabase
            .from('agreement_obligations')
            .select('id, agreement_id, due_on, amount, currency, agreement:agreements(title, counterparty_name)')
            .eq('company_id', companyId)
            .eq('status', 'missed')
            .order('due_on', { ascending: true })
            .limit(STEP_ITEMS_CAP),
        )
      ).map((r) => {
        const agreement = one(r.agreement)
        return {
          id: String(r.id),
          name: joined(agreement?.counterparty_name, agreement?.title),
          date: text(r.due_on) || null,
          amount: num(r.amount),
          currency: text(r.currency) || null,
          href: r.agreement_id ? `/arkiv/avtal/${r.agreement_id}` : href,
        }
      })
    default:
      return []
  }
}

/** The earliest date among the items, and their sum when all of them are listed in one currency. */
export function summarize(items: readonly StepItem[], total: number): StepItemsSummary {
  const dates = items.map((item) => item.date?.slice(0, 10)).filter((d): d is string => !!d)
  const earliest = dates.length > 0 ? dates.reduce((min, d) => (d < min ? d : min)) : null
  const complete = items.length > 0 && items.length >= total
  const currencies = new Set(items.map((item) => item.currency ?? 'SEK'))
  const sum =
    complete && currencies.size === 1 && items.every((item) => item.amount != null)
      ? { value: Math.round(items.reduce((acc, item) => acc + (item.amount as number), 0) * 100) / 100, currency: [...currencies][0] }
      : null
  return { earliest, sum }
}

/** Which word heads the date column: when it falls due, when it came in, else the date. */
const DATE_HEAD: Partial<Record<StepItemsKind, 'fact_due' | 'col_arrived'>> = {
  attest: 'fact_due',
  to_pay: 'fact_due',
  overdue: 'fact_due',
  deadlines: 'fact_due',
  agreement_missed: 'fact_due',
  given: 'fact_due',
  inbox: 'col_arrived',
  held_documents: 'col_arrived',
  unclassified: 'col_arrived',
  field_review: 'col_arrived',
}

/** The kinds that are never money: their table has no amount column. */
const NO_AMOUNT: ReadonlySet<StepItemsKind> = new Set(['missing_underlag', 'held_documents', 'unclassified', 'field_review', 'deadlines'])

export function StepItems({
  kind,
  total,
  href,
  items: given,
}: {
  kind: StepItemsKind
  total: number
  href: string
  /** kind 'given': the rows, which the page already holds. */
  items?: StepItem[]
}) {
  const t = useTranslations('hem')
  const tCommon = useTranslations('common')
  // An unread document is named as Inkommande names it.
  const tInkorg = useTranslations('inkorg')
  const doorName = useDoorName()
  const companyId = useCompanyOptional()?.company?.id ?? null
  const tellStep = useContext(StepSummarySink)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; items: StepItem[] }>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (kind === 'given') return
    let live = true
    const needsCompany = () => (companyId ? companyId : null)
    const load: Promise<StepItem[]> =
      kind === 'missing_underlag'
        ? loadMissingUnderlag()
        : kind === 'attest' || kind === 'to_pay'
          ? loadSupplierInvoices(kind)
          : kind === 'inbox'
            ? loadInbox(href)
            : needsCompany()
              ? kind === 'overdue'
                ? loadOverdueInvoices(companyId as string)
                : loadFromTables(kind, companyId as string, href)
              : Promise.reject(new Error('no company'))
    load
      .then((items) => {
        if (live) setState({ status: 'ready', items })
      })
      .catch(() => {
        if (live) setState({ status: 'error' })
      })
    return () => {
      live = false
    }
  }, [kind, companyId, attempt, href])

  const ready = kind === 'given' ? (given ?? []) : state.status === 'ready' ? state.items : null
  // The step's fields say the earliest date and, when every item is listed, the sum.
  useEffect(() => {
    if (ready && tellStep) tellStep(summarize(ready, total))
    // The list is replaced as a whole when it is read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, total])

  if (!ready && state.status === 'loading') {
    return (
      <LateReveal>
        <div className={LIST_BLEED_CLASS} aria-busy="true">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-11 items-center justify-between gap-4 border-b-hairline px-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </LateReveal>
    )
  }
  if (!ready) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {t('step_items_failed')}{' '}
        <button
          type="button"
          className="text-foreground underline underline-offset-[3px]"
          onClick={() => {
            setState({ status: 'loading' })
            setAttempt((n) => n + 1)
          }}
        >
          {tCommon('retry')}
        </button>
      </p>
    )
  }
  if (ready.length === 0) {
    // The count and the list are two reads: one that finds nothing says so and points at the page.
    return (
      <p className="text-[13px] text-muted-foreground">
        {t('step_items_empty')}{' '}
        <Link href={href} className="text-foreground underline underline-offset-[3px]">
          {t('step_open')}
        </Link>
      </p>
    )
  }

  const shown = ready.slice(0, STEP_ITEMS_CAP)
  const dateHead = t(DATE_HEAD[kind] ?? 'fact_date')
  const withAmount = !NO_AMOUNT.has(kind) && shown.some((item) => item.amount != null)
  const withDoor = shown.some((item) => item.door)
  return (
    <div className={LIST_BLEED_CLASS}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('col_what')}</th>
            {withDoor && <th className={cn(TH_CLASS, 'max-sm:hidden')}>{t('col_door')}</th>}
            <th className={cn(TH_CLASS, 'max-sm:hidden')}>{dateHead}</th>
            {withAmount && <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((item) => (
            <tr key={item.id} className="group relative hover:bg-secondary/35">
              <td className={cn(TD_CLASS, 'max-w-0')} data-ph-mask="">
                <span className="flex min-w-0 items-center gap-2">
                  {/* On a phone the door is its mark beside the name; from sm up it has a column with its name. */}
                  {item.door && (
                    <span className="shrink-0 sm:hidden" title={doorName(item.door)}>
                      <DoorMark door={item.door} />
                    </span>
                  )}
                  {/* The name is the link, stretched over the row: one tab stop, the whole row to press. */}
                  <Link
                    href={item.href}
                    className="min-w-0 truncate text-strong after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/70"
                  >
                    {item.name || (item.door ? tInkorg('row_unknown') : t('step_item_unnamed'))}
                  </Link>
                </span>
              </td>
              {withDoor && (
                <td className={cn(TD_CLASS, 'w-px whitespace-nowrap max-sm:hidden')}>
                  {item.door && (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <DoorMark door={item.door} />
                      {doorName(item.door)}
                    </span>
                  )}
                </td>
              )}
              <td className={cn(TD_CLASS, 'date-figures w-px whitespace-nowrap text-muted-foreground max-sm:hidden')}>{item.date ? formatDate(item.date) : ''}</td>
              {withAmount && (
                <td className={cn(TD_CLASS, 'w-px whitespace-nowrap pl-4 text-right tabular-nums')}>
                  {item.amount == null ? '' : amountText({ value: item.amount, currency: item.currency })}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {(total > shown.length || ready.length > shown.length) && (
        <p className="px-2 pt-3">
          <Link href={href} className={QUIET_LINK_CLASS}>
            {t('step_items_all', { count: Math.max(total, ready.length) })}
          </Link>
        </p>
      )}
    </div>
  )
}
