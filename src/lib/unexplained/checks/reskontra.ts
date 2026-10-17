/**
 * The reskontra checks: the open invoices of a register against the booked
 * balance of its control account. Both read the reconciliation the
 * kundreskontra and leverantörsreskontra pages show ("Avstämning mot 1510",
 * generateARReconciliation; the supplier twin generateReconciliation), so
 * the difference here is the difference a person sees on that card, and the
 * bokslut readiness warns about the same figure.
 *
 * Basis: every balance sheet account is reconciled against its underlag at
 * the closing (swedish-year-end-closing, Phase 1: 1510 against the
 * kundreskontra, 2440 against the leverantörsreskontra). Under kontantmetoden
 * open invoices reach 1510/2440 only through the bokslut entry, so the check
 * cannot run during the year (the readiness aggregator skips it the same way).
 *
 * The explanation names the two classic causes, each a list with handles:
 * open register invoices that no verifikat booked, and lines on the control
 * accounts this fiscal year from verifikat that no invoice or invoice payment
 * references and that the invoice engine did not write. What those lists do
 * not cover is the residual, with the reasons it usually has.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { toHandle } from '@/lib/handles'
import { INVOICE_ENGINE_SOURCE_TYPES } from '@/lib/invoices/invoice-register-coverage'
import { tiesOut } from '@/lib/measures/explain'
import { fiscalPeriodContaining } from '@/lib/measures/params'
import type { MeasureFiscalPeriod } from '@/lib/measures/types'
import { roundOre } from '@/lib/money'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { generateReconciliation as generateSupplierReconciliation } from '@/lib/reports/supplier-reconciliation'
import { chunk } from '@/lib/utils'
import {
  cannotCheck,
  companyFacts,
  kronor,
  noFiscalPeriod,
  roleAccounts,
  sourceFailed,
  statusFor,
  sumOre,
} from '../shared'
import type {
  CheckBreakdown,
  CheckContext,
  CheckDefinition,
  CheckItem,
  CheckPart,
  CheckRefusal,
  CheckRun,
  CheckSide,
  CheckSource,
} from '../types'

/** Öre: both totals are rounded to öre, so any non-zero difference is real. */
const TOLERANCE = 0.005

/** PostgREST URL length: ids per `.in()` lookup. */
const ID_CHUNK = 200

/**
 * The source types the supplier invoice flows write (registration, payment,
 * credit): their lines on the payables account are the register's own
 * bookkeeping. The customer side has the same list in
 * lib/invoices/invoice-register-coverage.ts.
 */
const SUPPLIER_INVOICE_ENGINE_SOURCE_TYPES = [
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'supplier_invoice_privately_paid',
  'supplier_credit_note',
] as const

/**
 * A storno or a correction belongs to the entry it reverses or corrects
 * (storno-service: reverses_id, correction_of_id): an invoice verifikat's
 * correction is the register's bookkeeping, a manual verifikat's storno is
 * not. The source-type lists leave these two out and the root decides.
 */
const FOLLOWS_ITS_ORIGINAL = new Set(['storno', 'correction'])

/** How far a correction of a correction is followed back. */
const MAX_ROOT_DEPTH = 4

type Side = 'receivables' | 'payables'

interface ReskontraSource {
  period: MeasureFiscalPeriod
  accounts: string[]
  registerTotal: number
  ledgerBalance: number
  preRegisterInPeriod: boolean
}

interface SideSpec {
  side: Side
  /** The ledger's normal balance: receivables are debit, payables credit. */
  normal: 'debit' | 'credit'
  registerSource: CheckSource
  ledgerSource: CheckSource
  cashMethod: CheckRefusal
  engineSourceTypes: readonly string[]
}

const AR: SideSpec = {
  side: 'receivables',
  normal: 'debit',
  registerSource: {
    report: 'Kundreskontra (öppna kundfakturor)',
    v1_path: '/reports/ar-ledger',
    mcp_tool: 'gnubok_get_ar_ledger',
    screen: '/reports/kundreskontra',
  },
  ledgerSource: {
    report: 'Huvudbok, kundfordringskontona (BAS 1510 och 1513), hela räkenskapsåret',
    v1_path: '/reports/general-ledger',
    mcp_tool: 'gnubok_get_general_ledger',
    screen: '/reports/huvudbok',
  },
  cashMethod: {
    code: 'CASH_METHOD',
    message_sv:
      'Bolaget använder kontantmetoden: obetalda kundfakturor bokförs först i bokslutet, så kundreskontran stäms av mot kundfordringarna först då.',
    message_en:
      'The company uses the cash method: unpaid customer invoices are booked only at the year-end closing, so the customer ledger is reconciled against receivables only then.',
  },
  engineSourceTypes: INVOICE_ENGINE_SOURCE_TYPES.filter((t) => !FOLLOWS_ITS_ORIGINAL.has(t)),
}

const AP: SideSpec = {
  side: 'payables',
  normal: 'credit',
  registerSource: {
    report: 'Leverantörsreskontra (öppna leverantörsfakturor)',
    v1_path: '/reports/supplier-ledger',
    mcp_tool: 'gnubok_get_supplier_ledger',
    screen: '/reports/supplier-ledger',
  },
  ledgerSource: {
    report: 'Huvudbok, leverantörsskuldkontot (BAS 2440), hela räkenskapsåret',
    v1_path: '/reports/general-ledger',
    mcp_tool: 'gnubok_get_general_ledger',
    screen: '/reports/huvudbok',
  },
  cashMethod: {
    code: 'CASH_METHOD',
    message_sv:
      'Bolaget använder kontantmetoden: obetalda leverantörsfakturor bokförs först i bokslutet, så leverantörsreskontran stäms av mot leverantörsskulderna först då.',
    message_en:
      'The company uses the cash method: unpaid supplier invoices are booked only at the year-end closing, so the supplier ledger is reconciled against payables only then.',
  },
  engineSourceTypes: SUPPLIER_INVOICE_ENGINE_SOURCE_TYPES,
}

function fxMissing(spec: SideSpec, count: number, difference: number): CheckRefusal {
  const sv = spec.side === 'receivables' ? 'kundfakturor' : 'leverantörsfakturor'
  const en = spec.side === 'receivables' ? 'customer invoices' : 'supplier invoices'
  return {
    code: 'FX_RATE_MISSING',
    message_sv: `${count} ${sv} i utländsk valuta saknar valutakurs, så reskontrans summa är ofullständig och avstämningen kan inte slutföras. Sätt kursen på fakturorna.`,
    message_en: `${count} foreign-currency ${en} have no exchange rate, so the register total is incomplete and the reconciliation cannot be completed. Set the rate on those invoices.`,
    details: { unconverted_fx_count: count, partial_difference: difference },
  }
}

function sidesOf(spec: SideSpec, registerTotal: number | null, ledgerBalance: number | null): CheckSide[] {
  const what = spec.side === 'receivables' ? 'kundfakturor' : 'leverantörsfakturor'
  return [
    {
      key: 'register',
      label_sv: `Öppna ${what} i reskontran`,
      label_en: spec.side === 'receivables' ? 'Open customer invoices in the register' : 'Open supplier invoices in the register',
      amount: registerTotal,
      source: spec.registerSource,
    },
    {
      key: 'ledger',
      label_sv: spec.side === 'receivables' ? 'Bokförda kundfordringar' : 'Bokförda leverantörsskulder',
      label_en: spec.side === 'receivables' ? 'Booked receivables' : 'Booked payables',
      amount: ledgerBalance,
      source: spec.ledgerSource,
    },
  ]
}

async function runSide(ctx: CheckContext, spec: SideSpec, checkId: string): Promise<CheckRun<ReskontraSource>[]> {
  const subject = { kind: 'company' } as const
  const asOf = ctx.today
  const report = spec.side === 'receivables' ? 'Kundreskontrans avstämning' : 'Leverantörsreskontrans avstämning'
  try {
    const facts = await companyFacts(ctx)
    if (facts.accountingMethod === 'cash') return [cannotCheck(subject, asOf, spec.cashMethod)]
    const roles = roleAccounts(
      facts,
      spec.side === 'receivables' ? ['accounts_receivable', 'rot_rut_receivable'] : ['accounts_payable'],
    )
    if (!roles.ok) return [cannotCheck(subject, asOf, roles.refusal)]
    const period = await fiscalPeriodContaining(ctx, asOf)
    if (!period) return [cannotCheck(subject, asOf, noFiscalPeriod(asOf))]

    let registerTotal: number
    let ledgerBalance: number
    let difference: number
    let fxCount: number
    let preRegisterInPeriod = false
    if (spec.side === 'receivables') {
      const card = await generateARReconciliation(ctx.supabase, ctx.companyId, period.id)
      registerTotal = card.ar_ledger_total
      ledgerBalance = card.account_1510_balance
      difference = roundOre(card.difference)
      fxCount = card.unconverted_fx_count
      preRegisterInPeriod = card.pre_register_ar_in_period === true
    } else {
      const card = await generateSupplierReconciliation(ctx.supabase, ctx.companyId, period.id)
      registerTotal = card.supplier_ledger_total
      ledgerBalance = card.account_2440_balance
      difference = roundOre(card.difference)
      fxCount = card.unconverted_fx_count
    }
    const sides = sidesOf(spec, registerTotal, ledgerBalance)
    if (fxCount > 0) return [cannotCheck(subject, asOf, fxMissing(spec, fxCount, difference), sides)]

    const status = statusFor(difference, TOLERANCE)
    const what = spec.side === 'receivables' ? 'Kundreskontran' : 'Leverantörsreskontran'
    const account = spec.side === 'receivables' ? 'kundfordringarna' : 'leverantörsskulderna'
    return [
      {
        subject,
        status,
        difference,
        as_of: asOf,
        summary_sv:
          status === 'ok'
            ? `${what} stämmer mot de bokförda ${account}.`
            : `${what} visar ${kronor(registerTotal)} men de bokförda ${account} är ${kronor(ledgerBalance)}: differens ${kronor(difference)}.`,
        sides,
        refusal: null,
        facts: { fiscal_period_id: period.id, ...(preRegisterInPeriod ? { pre_register_invoices_in_period: true } : {}) },
        source: { period, accounts: roles.accounts, registerTotal, ledgerBalance, preRegisterInPeriod },
      },
    ]
  } catch (err) {
    return [cannotCheck(subject, asOf, sourceFailed(checkId, report, err))]
  }
}

/** The ids of `entryIds` that an invoice, a supplier invoice or a payment of either references. */
async function referencedEntryIds(
  supabase: SupabaseClient,
  companyId: string,
  side: Side,
  entryIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  const add = (rows: unknown[] | null, key: string) => {
    for (const row of rows ?? []) {
      const id = (row as Record<string, unknown>)[key]
      if (typeof id === 'string') out.add(id)
    }
  }
  for (const part of chunk(entryIds, ID_CHUNK)) {
    if (side === 'receivables') {
      const [invoices, payments] = await Promise.all([
        supabase.from('invoices').select('journal_entry_id').eq('company_id', companyId).in('journal_entry_id', part),
        supabase.from('invoice_payments').select('journal_entry_id').eq('company_id', companyId).in('journal_entry_id', part),
      ])
      if (invoices.error) throw Object.assign(new Error(invoices.error.message), { code: invoices.error.code })
      if (payments.error) throw Object.assign(new Error(payments.error.message), { code: payments.error.code })
      add(invoices.data, 'journal_entry_id')
      add(payments.data, 'journal_entry_id')
    } else {
      const [registered, paid, payments] = await Promise.all([
        supabase
          .from('supplier_invoices')
          .select('registration_journal_entry_id')
          .eq('company_id', companyId)
          .in('registration_journal_entry_id', part),
        supabase
          .from('supplier_invoices')
          .select('payment_journal_entry_id')
          .eq('company_id', companyId)
          .in('payment_journal_entry_id', part),
        supabase
          .from('supplier_invoice_payments')
          .select('journal_entry_id')
          .eq('company_id', companyId)
          .in('journal_entry_id', part),
      ])
      for (const res of [registered, paid, payments]) {
        if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code })
      }
      add(registered.data, 'registration_journal_entry_id')
      add(paid.data, 'payment_journal_entry_id')
      add(payments.data, 'journal_entry_id')
    }
  }
  return out
}

/** Open register invoices (from the reskontra report) that no verifikat booked. */
async function registerWithoutVoucher(ctx: CheckContext, side: Side): Promise<CheckItem[]> {
  const open: Array<Omit<CheckItem, 'part' | 'item_type'> & { id: string }> = []
  if (side === 'receivables') {
    const ledger = await generateARLedger(ctx.supabase, ctx.companyId, undefined, { strict: true })
    for (const entry of ledger.entries) {
      for (const invoice of entry.invoices) {
        if (invoice.outstanding === 0 || invoice.outstanding_sek === null) continue
        open.push({
          id: invoice.invoice_id,
          invoice_id: invoice.invoice_id,
          handle: toHandle('invoice', invoice.invoice_id),
          date: invoice.invoice_date || null,
          label: `Faktura ${invoice.invoice_number || 'utan nummer'}, ${entry.customer_name}`,
          amount: roundOre(invoice.outstanding_sek),
          currency: invoice.currency,
        })
      }
    }
  } else {
    const ledger = await generateSupplierLedger(ctx.supabase, ctx.companyId, undefined, { strict: true, includeInvoices: true })
    for (const entry of ledger.entries) {
      for (const invoice of entry.invoices ?? []) {
        if (invoice.outstanding === 0) continue
        const number = invoice.supplier_invoice_number ?? (invoice.arrival_number !== null ? `ankomst ${invoice.arrival_number}` : 'utan nummer')
        open.push({
          id: invoice.supplier_invoice_id,
          supplier_invoice_id: invoice.supplier_invoice_id,
          handle: toHandle('supplier_invoice', invoice.supplier_invoice_id),
          date: invoice.invoice_date || null,
          label: `Leverantörsfaktura ${number}, ${entry.supplier_name}`,
          amount: roundOre(invoice.outstanding_sek),
          currency: invoice.currency,
        })
      }
    }
  }
  if (open.length === 0) return []

  const booked = new Set<string>()
  for (const part of chunk(open.map((o) => o.id), ID_CHUNK)) {
    if (side === 'receivables') {
      const { data, error } = await ctx.supabase
        .from('invoices')
        .select('id, journal_entry_id')
        .eq('company_id', ctx.companyId)
        .in('id', part)
      if (error) throw Object.assign(new Error(error.message), { code: error.code })
      for (const row of (data ?? []) as Array<{ id: string; journal_entry_id: string | null }>) {
        if (row.journal_entry_id) booked.add(row.id)
      }
    } else {
      const { data, error } = await ctx.supabase
        .from('supplier_invoices')
        .select('id, registration_journal_entry_id')
        .eq('company_id', ctx.companyId)
        .in('id', part)
      if (error) throw Object.assign(new Error(error.message), { code: error.code })
      for (const row of (data ?? []) as Array<{ id: string; registration_journal_entry_id: string | null }>) {
        if (row.registration_journal_entry_id) booked.add(row.id)
      }
    }
  }
  return open
    .filter((o) => !booked.has(o.id))
    .map(({ id: _id, ...item }) => ({
      part: 'register_without_voucher',
      item_type: side === 'receivables' ? 'invoice' : 'supplier_invoice',
      ...item,
    }))
}

interface EntryRoot {
  /** The entry a storno or correction chain starts from; the entry itself otherwise. */
  rootId: string
  rootSource: string
}

/**
 * The root of each entry: a storno or correction is followed back to the
 * entry it reverses or corrects, up to MAX_ROOT_DEPTH links. An entry whose
 * chain cannot be read to the end keeps the last entry read as its root.
 */
async function entryRoots(
  supabase: SupabaseClient,
  companyId: string,
  entries: Map<string, string>,
): Promise<Map<string, EntryRoot>> {
  const heads = new Map<string, { source_type: string; parent: string | null }>()
  let pending = [...entries.keys()]
  for (let depth = 0; depth <= MAX_ROOT_DEPTH && pending.length > 0; depth++) {
    const next = new Set<string>()
    for (const part of chunk(pending, ID_CHUNK)) {
      const { data, error } = await supabase
        .from('journal_entries')
        .select('id, source_type, reverses_id, correction_of_id')
        .eq('company_id', companyId)
        .in('id', part)
      if (error) throw Object.assign(new Error(error.message), { code: error.code })
      for (const row of (data ?? []) as Array<{
        id: string
        source_type: string | null
        reverses_id: string | null
        correction_of_id: string | null
      }>) {
        const source = row.source_type ?? ''
        const parent = FOLLOWS_ITS_ORIGINAL.has(source) ? (row.reverses_id ?? row.correction_of_id ?? null) : null
        heads.set(row.id, { source_type: source, parent })
        if (parent && !heads.has(parent)) next.add(parent)
      }
    }
    pending = [...next]
  }
  const roots = new Map<string, EntryRoot>()
  for (const [id, source] of entries) {
    let rootId = id
    let rootSource = heads.get(id)?.source_type ?? source
    for (let depth = 0; depth < MAX_ROOT_DEPTH; depth++) {
      const parent = heads.get(rootId)?.parent
      if (!parent || !heads.has(parent)) break
      rootId = parent
      rootSource = heads.get(parent)!.source_type
    }
    roots.set(id, { rootId, rootSource })
  }
  return roots
}

/**
 * Lines on the control accounts this fiscal year (the huvudbok generator,
 * opening balance excluded) whose verifikat the invoice engine did not write
 * and that no invoice or payment references, a storno or correction judged
 * by the entry it reverses or corrects. Signed as they move the difference:
 * the ledger is subtracted, so a receivables debit counts negative and a
 * payables credit counts negative.
 */
async function ledgerWithoutInvoice(
  ctx: CheckContext,
  spec: SideSpec,
  source: ReskontraSource,
): Promise<{ items: CheckItem[]; opening: number; ledgerTotal: number }> {
  const sorted = [...source.accounts].sort()
  const gl = await generateGeneralLedger(ctx.supabase, ctx.companyId, source.period.id, sorted[0], sorted[sorted.length - 1])
  const wanted = new Set(source.accounts)
  const engine = new Set<string>(spec.engineSourceTypes)
  const sign = spec.normal === 'debit' ? 1 : -1
  let opening = 0
  let ledgerTotal = 0
  const candidates: Array<CheckItem & { journal_entry_id: string }> = []
  const candidateSources = new Map<string, string>()
  for (const account of gl.accounts) {
    if (!wanted.has(account.account_number)) continue
    opening += sign * account.opening_balance
    ledgerTotal += sign * account.closing_balance
    for (const line of account.lines) {
      if (engine.has(line.source_type)) continue
      candidateSources.set(line.journal_entry_id, line.source_type)
      candidates.push({
        part: 'ledger_without_invoice',
        item_type: 'journal_line',
        journal_entry_id: line.journal_entry_id,
        account_number: account.account_number,
        handle: toHandle('journal_entry', line.journal_entry_id),
        date: line.date,
        label: `${line.voucher_series}${line.voucher_number} ${line.description}`.trim(),
        // The ledger side is subtracted from the register.
        amount: roundOre(-sign * (line.debit - line.credit)),
      })
    }
  }
  const followed = new Map([...candidateSources].filter(([, type]) => FOLLOWS_ITS_ORIGINAL.has(type)))
  const roots = followed.size > 0 ? await entryRoots(ctx.supabase, ctx.companyId, followed) : new Map<string, EntryRoot>()
  const rootOf = (id: string): EntryRoot => roots.get(id) ?? { rootId: id, rootSource: candidateSources.get(id) ?? '' }
  const referenced = await referencedEntryIds(
    ctx.supabase,
    ctx.companyId,
    spec.side,
    [...new Set([...candidateSources.keys(), ...[...roots.values()].map((r) => r.rootId)])],
  )
  return {
    items: candidates.filter((c) => {
      const root = rootOf(c.journal_entry_id)
      return !engine.has(root.rootSource) && !referenced.has(c.journal_entry_id) && !referenced.has(root.rootId)
    }),
    opening: roundOre(opening),
    ledgerTotal: roundOre(ledgerTotal),
  }
}

async function explainSide(ctx: CheckContext, spec: SideSpec, run: CheckRun<ReskontraSource>): Promise<CheckBreakdown> {
  const source = run.source
  if (!source || run.difference === null) return { parts: [], items: [], residual: null, reconciles: false }
  const [unbooked, ledger] = await Promise.all([registerWithoutVoucher(ctx, spec.side), ledgerWithoutInvoice(ctx, spec, source)])
  const items = [...unbooked, ...ledger.items].sort(
    (a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.label.localeCompare(b.label),
  )
  const isAr = spec.side === 'receivables'
  const parts: CheckPart[] = [
    {
      key: 'register_without_voucher',
      label_sv: isAr ? 'Öppna kundfakturor utan verifikat' : 'Öppna leverantörsfakturor utan verifikat',
      label_en: isAr ? 'Open customer invoices without a verifikat' : 'Open supplier invoices without a verifikat',
      amount: sumOre(unbooked.map((i) => i.amount)),
      count: unbooked.length,
    },
    {
      key: 'ledger_without_invoice',
      label_sv: isAr
        ? 'Verifikat på kundfordringskontona utan faktura i reskontran'
        : 'Verifikat på leverantörsskuldkontot utan faktura i reskontran',
      label_en: isAr
        ? 'Vouchers on the receivables accounts without an invoice in the register'
        : 'Vouchers on the payables account without an invoice in the register',
      amount: sumOre(ledger.items.map((i) => i.amount)),
      count: ledger.items.length,
    },
  ]
  const explained = sumOre(parts.map((p) => p.amount))
  const residual = roundOre(run.difference - explained)
  const reconciles = tiesOut(explained, run.difference, items.length + 1)
  const notes: string[] = []
  if (!reconciles) {
    notes.push(
      `The two lists explain ${explained} of ${run.difference}. The residual is usually the part of the opening balance (${ledger.opening}) that has no invoice in the register, invoices whose payments in the register differ from their payment verifikat (marked paid without a verifikat, or a payment booked without marking the invoice), or rate differences on foreign-currency invoices.`,
    )
  }
  if (source.preRegisterInPeriod) {
    notes.push('Verifikat outside the invoice engine debit the receivables before the register\'s first invoice this fiscal year: invoice history exists only as journal entries.')
  }
  if (!tiesOut(ledger.ledgerTotal, source.ledgerBalance, 2)) {
    notes.push(`The huvudbok closes the accounts at ${ledger.ledgerTotal} while the reconciliation reads ${source.ledgerBalance}: an opening balance carried from an earlier year without an ingående balans verifikat.`)
  }
  return {
    parts,
    items,
    residual,
    reconciles,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  }
}

export const receivablesVsLedger: CheckDefinition<ReskontraSource> = {
  id: 'receivables_vs_ledger',
  name_sv: 'Kundreskontran mot bokförda kundfordringar',
  name_en: 'Customer ledger against booked receivables',
  definition:
    'Open customer invoices in the invoice register now (kundreskontra: outstanding amount in SEK at each invoice\'s rate, credit notes netted, ROT/RUT shares still owed by Skatteverket included) minus the booked balance of the receivables accounts (the accounts_receivable and rot_rut_receivable roles, BAS 1510 and 1513 in the Swedish pack) over the fiscal year that contains today, every posted entry of that year with its opening balance. Exactly the "Avstämning mot 1510" figure on the kundreskontra report. Zero means every open invoice is booked and nothing else sits on the accounts. Faktureringsmetoden only.',
  definition_sv:
    'Öppna kundfakturor i fakturaregistret just nu (kundreskontran, utestående i kronor efter varje fakturas kurs, kreditfakturor nettade, ROT/RUT-andelar som Skatteverket ännu inte betalat inräknade) minus bokfört saldo på kundfordringskontona (BAS 1510 och 1513) för räkenskapsåret som omfattar dagens datum. Samma differens som avstämningen mot 1510 i kundreskontran. Noll betyder att varje öppen faktura är bokförd och att inget annat ligger på kontona. Bara faktureringsmetoden.',
  basis:
    'Every balance sheet account is reconciled against its underlag: 1510 Kundfordringar against the kundreskontra (open invoices), Phase 1 of the bokslut (swedish-year-end-closing). Under kontantmetoden open invoices reach 1510 only through the bokslut entry (BFL 5 kap.), so the check does not run then.',
  unit: 'SEK',
  tolerance: TOLERANCE,
  subject_kind: 'company',
  compares: [AR.registerSource, AR.ledgerSource],
  next_action: {
    message_sv:
      'Öppna förklaringen: koppla fakturor utan verifikat till sitt verifikat, markera betalda fakturor som betalda, och rätta verifikat på 1510 som inte hör till någon faktura.',
    tool: 'gnubok_link_invoice_to_voucher',
    screen: '/reports/kundreskontra',
  },
  run: (ctx) => runSide(ctx, AR, 'receivables_vs_ledger'),
  explain: (ctx, run) => explainSide(ctx, AR, run),
}

export const payablesVsLedger: CheckDefinition<ReskontraSource> = {
  id: 'payables_vs_ledger',
  name_sv: 'Leverantörsreskontran mot bokförda leverantörsskulder',
  name_en: 'Supplier ledger against booked payables',
  definition:
    'Open supplier invoices in the supplier invoice register now (leverantörsreskontra: registered, approved, overdue and partly paid invoices, remaining amount in SEK at each invoice\'s rate) minus the booked balance (credit minus debit) of the payables account (the accounts_payable role, BAS 2440 in the Swedish pack) over the fiscal year that contains today, every posted entry of that year with its opening balance. Exactly the reconciliation figure on the leverantörsreskontra report. Zero means every open supplier invoice is booked and nothing else sits on the account. Faktureringsmetoden only.',
  definition_sv:
    'Öppna leverantörsfakturor i registret just nu (leverantörsreskontran, återstående i kronor efter varje fakturas kurs) minus bokfört saldo (kredit minus debet) på leverantörsskuldkontot (BAS 2440) för räkenskapsåret som omfattar dagens datum. Samma differens som avstämningen i leverantörsreskontran. Noll betyder att varje öppen leverantörsfaktura är bokförd och att inget annat ligger på kontot. Bara faktureringsmetoden.',
  basis:
    'Every balance sheet account is reconciled against its underlag: 2440 Leverantörsskulder against the leverantörsreskontra, Phase 1 of the bokslut (swedish-year-end-closing). Under kontantmetoden open supplier invoices reach 2440 only through the bokslut entry, so the check does not run then.',
  unit: 'SEK',
  tolerance: TOLERANCE,
  subject_kind: 'company',
  compares: [AP.registerSource, AP.ledgerSource],
  next_action: {
    message_sv:
      'Öppna förklaringen: koppla leverantörsfakturor utan verifikat till sitt verifikat och rätta verifikat på 2440 som inte hör till någon faktura.',
    tool: 'gnubok_link_supplier_invoice_to_voucher',
    screen: '/reports/supplier-ledger',
  },
  run: (ctx) => runSide(ctx, AP, 'payables_vs_ledger'),
  explain: (ctx, run) => explainSide(ctx, AP, run),
}
