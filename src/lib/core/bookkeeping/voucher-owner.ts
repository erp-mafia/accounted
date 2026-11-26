import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isCreditableInvoiceStatus,
  isCreditableSupplierInvoiceStatus,
} from '@/lib/bookkeeping/creditable-statuses'
import { createLogger } from '@/lib/logger'
import { correctionChainRoot } from './correction-chain'

const log = createLogger('voucher-owner')

/**
 * Which object owns a verifikat, and what to do there instead.
 *
 * Some verifikat are the books of an object that lives outside the ledger:
 * an invoice's registration, a periodisering's monthly upplösning, a
 * depreciation in the asset register, a payroll run's postings. Vänd or Rätta
 * on such a verifikat changes the books and leaves the object as it was: the
 * invoice stays open in reskontran, the schedule counts the month as posted,
 * and a later Kreditera reverses the invoice a second time. The object's own
 * action keeps both in step, so every surface that offers Vänd or Rätta asks
 * this module first and leads with that action: the verifikat page and list,
 * the dashboard and v1 reverse/correct routes, and the MCP staging of
 * gnubok_reverse_journal_entry and gnubok_correct_entry.
 *
 * It never refuses anything: the verifikat stays reversible on its own (an
 * agent or a bulk flow may mean exactly that). Payment vouchers have no
 * owner here: their Vänd runs a reversal hook that keeps the invoice in step
 * (lib/composition/reversal-hooks.ts).
 *
 * A storno or correction belongs to whatever its chain root belongs to
 * (correctionChainRoot): reverseEntry books 'storno' and correctEntry
 * 'correction', so the owner is read off the original.
 *
 * Owners are found by the voucher's own source columns or by the register
 * row that points at it, never by an invoice's journal_entry_id: that pointer
 * can name a reversed voucher whose replacement is an unlinked import twin.
 */

export type VoucherOwnerKind =
  | 'invoice'
  | 'credit_note'
  | 'supplier_invoice'
  | 'supplier_credit_note'
  | 'accrual_schedule'
  | 'asset'
  | 'salary_run'

export type VoucherOwnerAction =
  | 'credit_invoice'
  | 'open_invoice'
  | 'credit_supplier_invoice'
  | 'open_supplier_invoice'
  | 'open_accrual'
  | 'open_asset'
  | 'open_salary_run'

export interface VoucherOwner {
  kind: VoucherOwnerKind
  /** The owner's id, of the table `kind` names (polymorphic, like a journal entry's source_id). */
  owner_id: string
  /**
   * What the owner is known by: the invoice or supplier invoice number, the
   * payroll period (YYYY-MM), the asset's name, the periodisering's text.
   * Null when it has none (a supplier invoice stored without a number).
   */
  label: string | null
  /** The owner's own page in the dashboard. */
  href: string
  action: VoucherOwnerAction
  /** Where `action` is done: the credit flow for a Kreditera, else the owner's page. */
  action_href: string
  /** The MCP tool that does the action for an agent, when there is one. */
  tool: string | null
  /** One sentence for an API caller or agent: whose verifikat this is and what to do there. */
  hint_sv: string
  hint_en: string
}

/** A verifikat as the resolver reads it; the source columns are fetched when absent. */
export interface VoucherOwnerEntry {
  id: string
  source_type?: string | null
  source_id?: string | null
  correction_of_id?: string | null
  reverses_id?: string | null
}

/**
 * The source types an owner books, and where the owner is found: the
 * voucher's own source_id (the engine writes the owner's id there), or the
 * register row whose foreign key points at the voucher (the voucher carries
 * no owner id: a depreciation is booked as 'year_end', an asset disposal as
 * 'system', beside year-end and system entries that have no owner).
 */
export const VOUCHER_OWNER_SOURCES: Readonly<
  Record<string, { kind: VoucherOwnerKind; via: 'source_id' | 'depreciation_schedules' | 'asset_disposal' }>
> = Object.freeze({
  invoice_created: { kind: 'invoice', via: 'source_id' },
  credit_note: { kind: 'credit_note', via: 'source_id' },
  supplier_invoice_registered: { kind: 'supplier_invoice', via: 'source_id' },
  supplier_credit_note: { kind: 'supplier_credit_note', via: 'source_id' },
  accrual: { kind: 'accrual_schedule', via: 'source_id' },
  salary_payment: { kind: 'salary_run', via: 'source_id' },
  year_end: { kind: 'asset', via: 'depreciation_schedules' },
  system: { kind: 'asset', via: 'asset_disposal' },
})

/**
 * Whether a verifikat of this source type can have an owner at all, so a
 * list asks only for those: the owned source types and the storno and
 * correction rows that inherit their root's owner.
 */
export function mayHaveVoucherOwner(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return sourceType in VOUCHER_OWNER_SOURCES || sourceType === 'storno' || sourceType === 'correction'
}

const ACTION_TOOLS: Readonly<Record<VoucherOwnerAction, string | null>> = {
  credit_invoice: 'gnubok_credit_invoice',
  open_invoice: null,
  credit_supplier_invoice: 'gnubok_credit_supplier_invoice',
  open_supplier_invoice: null,
  open_accrual: 'gnubok_list_accrual_schedules',
  open_asset: null,
  open_salary_run: 'gnubok_correct_salary_run',
}

const OWNER_NAMES: Readonly<Record<VoucherOwnerKind, { sv: string; en: string }>> = {
  invoice: { sv: 'faktura', en: 'invoice' },
  credit_note: { sv: 'kreditfaktura', en: 'credit note' },
  supplier_invoice: { sv: 'leverantörsfaktura', en: 'supplier invoice' },
  supplier_credit_note: { sv: 'leverantörskreditfaktura', en: 'supplier credit note' },
  accrual_schedule: { sv: 'periodisering', en: 'accrual' },
  asset: { sv: 'anläggningstillgång', en: 'fixed asset' },
  salary_run: { sv: 'lönekörning', en: 'payroll run' },
}

const ACTION_HINTS: Readonly<Record<VoucherOwnerAction, { sv: string; en: string }>> = {
  credit_invoice: {
    sv: 'Kreditera fakturan i stället, så följer fakturan, kundreskontran och periodiseringarna med.',
    en: 'Credit the invoice instead, so the invoice, the receivables ledger and its accruals follow.',
  },
  open_invoice: {
    sv: 'Ändra den på fakturan i stället, så följer reskontran med.',
    en: 'Change it on the invoice instead, so the ledger follows.',
  },
  credit_supplier_invoice: {
    sv: 'Kreditera fakturan i stället, så följer fakturan, leverantörsreskontran och periodiseringarna med.',
    en: 'Credit the invoice instead, so the invoice, the payables ledger and its accruals follow.',
  },
  open_supplier_invoice: {
    sv: 'Ändra den på fakturan i stället, så följer reskontran med.',
    en: 'Change it on the invoice instead, so the ledger follows.',
  },
  open_accrual: {
    sv: 'Ändra periodiseringen i stället, annars räknar den månaden som bokförd.',
    en: 'Change the accrual instead, or it keeps counting the month as posted.',
  },
  open_asset: {
    sv: 'Ändra i anläggningsregistret i stället, annars räknar registret med verifikationen.',
    en: 'Change it in the fixed asset register instead, or the register keeps counting the voucher.',
  },
  open_salary_run: {
    sv: 'Korrigera hela lönekörningen i stället, så vänds alla dess verifikationer tillsammans.',
    en: 'Correct the whole payroll run instead, so all its vouchers are reversed together.',
  },
}

/**
 * What an open_supplier_invoice hint says when the invoice's page offers
 * something particular: Ångra kreditering is there only on a credited
 * invoice (and is where a supplier credit note is undone), and a paid or
 * part-paid invoice's page changes nothing of its verifikat, so a line-only
 * fix is a radrättelse inside it, which the invoice keeps pointing at.
 */
const SUPPLIER_INVOICE_HINTS = {
  uncredit: {
    sv: 'Ändra den på fakturan i stället (Ångra kreditering), så följer reskontran med.',
    en: 'Change it on the invoice instead (Undo credit), so the ledger follows.',
  },
  paid: {
    sv: 'Fakturan är betald eller delbetald, och dess sida ändrar inte verifikationen. Rör rättelsen bara rader och inte leverantörsskulden, gör den som radrättelse i samma verifikation (gnubok_correct_entry_lines), så pekar fakturan kvar på den.',
    en: 'The invoice is paid or part-paid, and its page does not change the voucher. If the correction changes only lines and not the payable, make it a line correction in the same voucher (gnubok_correct_entry_lines), so the invoice keeps pointing at it.',
  },
} as const

type OwnerFound = {
  kind: VoucherOwnerKind
  owner_id: string
  label: string | null
  action: VoucherOwnerAction
  href: string
  action_href: string
  /** A hint in place of the action's own (SUPPLIER_INVOICE_HINTS). */
  hint?: keyof typeof SUPPLIER_INVOICE_HINTS
}

function withHint({ hint, ...owner }: OwnerFound): VoucherOwner {
  const name = OWNER_NAMES[owner.kind]
  const label = owner.label ? ` ${owner.label}` : ''
  const action = hint ? SUPPLIER_INVOICE_HINTS[hint] : ACTION_HINTS[owner.action]
  return {
    ...owner,
    tool: ACTION_TOOLS[owner.action],
    hint_sv: `Verifikationen hör till ${name.sv}${label}. ${action.sv}`,
    hint_en: `This voucher belongs to ${name.en}${label}. ${action.en}`,
  }
}

async function readSourceColumns(
  supabase: SupabaseClient,
  companyId: string,
  entry: VoucherOwnerEntry,
): Promise<VoucherOwnerEntry | null> {
  if (entry.source_type !== undefined) return entry
  const { data } = await supabase
    .from('journal_entries')
    .select('id, source_type, source_id, correction_of_id, reverses_id')
    .eq('company_id', companyId)
    .eq('id', entry.id)
    .maybeSingle()
  return (data as VoucherOwnerEntry | null) ?? null
}

async function findOwner(
  supabase: SupabaseClient,
  companyId: string,
  root: { id: string; source_type: string | null; source_id: string | null },
): Promise<OwnerFound | null> {
  const source = root.source_type ? VOUCHER_OWNER_SOURCES[root.source_type] : undefined
  if (!source) return null

  if (source.via === 'source_id') {
    if (!root.source_id) return null
    switch (source.kind) {
      case 'invoice':
      case 'credit_note': {
        const { data } = await supabase
          .from('invoices')
          .select('id, invoice_number, status')
          .eq('company_id', companyId)
          .eq('id', root.source_id)
          .maybeSingle()
        const row = data as { id: string; invoice_number: string | null; status: string } | null
        if (!row) return null
        const credit = source.kind === 'invoice' && isCreditableInvoiceStatus(row.status)
        return {
          kind: source.kind,
          owner_id: row.id,
          label: row.invoice_number ?? null,
          action: credit ? 'credit_invoice' : 'open_invoice',
          href: `/invoices/${row.id}`,
          action_href: credit ? `/invoices/${row.id}/credit` : `/invoices/${row.id}`,
        }
      }
      case 'supplier_invoice':
      case 'supplier_credit_note': {
        const { data } = await supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, status, credited_invoice_id')
          .eq('company_id', companyId)
          .eq('id', root.source_id)
          .maybeSingle()
        const row = data as {
          id: string
          supplier_invoice_number: string | null
          status: string
          credited_invoice_id: string | null
        } | null
        if (!row) return null
        if (source.kind === 'supplier_credit_note') {
          // Ångra kreditering lives on the invoice the credit note credits.
          const target = row.credited_invoice_id ?? row.id
          return {
            kind: 'supplier_credit_note',
            owner_id: row.id,
            label: row.supplier_invoice_number ?? null,
            action: 'open_supplier_invoice',
            href: `/supplier-invoices/${target}`,
            action_href: `/supplier-invoices/${target}`,
            hint: 'uncredit',
          }
        }
        const credit = isCreditableSupplierInvoiceStatus(row.status)
        // The page offers Ångra kreditering on a credited invoice only.
        let hint: OwnerFound['hint']
        if (row.status === 'credited') hint = 'uncredit'
        else if (row.status === 'paid' || row.status === 'partially_paid') hint = 'paid'
        return {
          kind: 'supplier_invoice',
          owner_id: row.id,
          label: row.supplier_invoice_number ?? null,
          action: credit ? 'credit_supplier_invoice' : 'open_supplier_invoice',
          href: `/supplier-invoices/${row.id}`,
          action_href: credit ? `/supplier-invoices/${row.id}?action=credit` : `/supplier-invoices/${row.id}`,
          ...(hint ? { hint } : {}),
        }
      }
      case 'accrual_schedule': {
        const { data } = await supabase
          .from('accrual_schedules')
          .select('id, description')
          .eq('company_id', companyId)
          .eq('id', root.source_id)
          .maybeSingle()
        const row = data as { id: string; description: string | null } | null
        if (!row) return null
        return {
          kind: 'accrual_schedule',
          owner_id: row.id,
          label: row.description || null,
          action: 'open_accrual',
          href: '/bookkeeping/periodiseringar',
          action_href: '/bookkeeping/periodiseringar',
        }
      }
      case 'salary_run': {
        const { data } = await supabase
          .from('salary_runs')
          .select('id, period_year, period_month')
          .eq('company_id', companyId)
          .eq('id', root.source_id)
          .maybeSingle()
        const row = data as { id: string; period_year: number; period_month: number } | null
        if (!row) return null
        return {
          kind: 'salary_run',
          owner_id: row.id,
          label: `${row.period_year}-${String(row.period_month).padStart(2, '0')}`,
          action: 'open_salary_run',
          href: `/salary/runs/${row.id}`,
          action_href: `/salary/runs/${row.id}`,
        }
      }
      default:
        return null
    }
  }

  // Register rows that point at the voucher (no owner id on the voucher).
  const { data } =
    source.via === 'depreciation_schedules'
      ? await supabase
          .from('depreciation_schedules')
          .select('asset:assets(id, name)')
          .eq('company_id', companyId)
          .eq('journal_entry_id', root.id)
          .limit(1)
          .maybeSingle()
      : await supabase
          .from('assets')
          .select('id, name')
          .eq('company_id', companyId)
          .eq('disposal_journal_entry_id', root.id)
          .limit(1)
          .maybeSingle()
  let found = data as { asset?: unknown; id?: string; name?: string } | null
  // A K3 component replacement is a system voucher too, owned by the asset
  // whose component it took off the books (asset_components).
  if (!found && source.via === 'asset_disposal') {
    const { data: component } = await supabase
      .from('asset_components')
      .select('asset:assets!asset_components_asset_id_fkey(id, name)')
      .eq('company_id', companyId)
      .eq('derecognition_journal_entry_id', root.id)
      .limit(1)
      .maybeSingle()
    found = component as { asset?: unknown } | null
  }
  // So is a nedskrivning or its reversal (asset_value_adjustments).
  if (!found && source.via === 'asset_disposal') {
    const { data: adjustment } = await supabase
      .from('asset_value_adjustments')
      .select('asset:assets!asset_value_adjustments_asset_id_fkey(id, name)')
      .eq('company_id', companyId)
      .eq('journal_entry_id', root.id)
      .limit(1)
      .maybeSingle()
    found = adjustment as { asset?: unknown } | null
  }
  const embedded = found && 'asset' in found ? found.asset : found
  const asset = (Array.isArray(embedded) ? embedded[0] : embedded) as { id?: string; name?: string } | null
  if (!asset?.id) return null
  return {
    kind: 'asset',
    owner_id: asset.id,
    label: asset.name ?? null,
    action: 'open_asset',
    href: '/assets',
    action_href: '/assets',
  }
}

/**
 * The object that owns a verifikat, or null when it has none (a manual
 * verifikat, a payment voucher, an import) or the owner cannot be read. Every
 * read is company-scoped.
 */
export async function resolveVoucherOwner(
  supabase: SupabaseClient,
  companyId: string,
  entry: VoucherOwnerEntry,
): Promise<VoucherOwner | null> {
  const row = await readSourceColumns(supabase, companyId, entry)
  if (!row) return null
  // reverseEntry books 'storno' and correctEntry 'correction': only those
  // descend from another verifikat whose owner they share.
  const inChain = row.source_type === 'storno' || row.source_type === 'correction'
  const root = inChain
    ? await correctionChainRoot(supabase, companyId, row)
    : { id: row.id, source_type: row.source_type ?? null, source_id: row.source_id ?? null }
  if (!root) return null
  const owner = await findOwner(supabase, companyId, root)
  return owner ? withHint(owner) : null
}

/**
 * resolveVoucherOwner for a response that must not fail because of it: the
 * owner is advice, so a read error answers null instead of failing the
 * action it rides on.
 */
export async function voucherOwnerOrNull(
  supabase: SupabaseClient,
  companyId: string,
  entry: VoucherOwnerEntry,
): Promise<VoucherOwner | null> {
  try {
    return await resolveVoucherOwner(supabase, companyId, entry)
  } catch (error) {
    log.warn('voucher owner lookup failed; answering without an owner', {
      companyId,
      entryId: entry.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
