import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { LINK_BASES, LinkEvidenceSchema, readLinkBasis } from './link-basis'

/**
 * Everything linked to one verifikat, each link with its recorded basis: the
 * read side of link basis (./link-basis.ts). Read-only, additive to the
 * voucher reads that already show links to agents (MCP gnubok_get_record,
 * v1 GET journal-entries/{id}).
 *
 *   bank_transaction          a bank row whose verifikat link points here,
 *                             through its own pointer or a voucher link
 *                             (samlingsverifikat, 1:N split, residual)
 *   document                  an underlag on the verifikat
 *   invoice_payment           a customer payment booked on it
 *   supplier_invoice_payment  a supplier payment booked on it
 *   ledger_settlement         a live settlement of it against other verifikat
 *
 * basis and evidence are what the writer recorded; null on a link written
 * before 2026-10-16 or by a writer that does not stamp yet: not recorded,
 * never guessed here.
 */

/** At most this many links of one kind: a samlingsverifikat can carry hundreds of bank rows. */
export const MAX_VOUCHER_LINKS_PER_KIND = 100

export const VOUCHER_LINK_KINDS = [
  'bank_transaction',
  'document',
  'invoice_payment',
  'supplier_invoice_payment',
  'ledger_settlement',
] as const

export const VoucherLinkSchema = z.object({
  kind: z.enum(VOUCHER_LINK_KINDS),
  transaction_id: z.string().uuid().nullable().describe('The bank row, for bank_transaction and for a payment matched from one.'),
  via: z
    .enum(['pointer', 'voucher_link'])
    .nullable()
    .describe("bank_transaction only: the row's own pointer, or a voucher link (samlingsverifikat, split, residual)."),
  document_id: z.string().uuid().nullable(),
  invoice_id: z.string().uuid().nullable(),
  invoice_payment_id: z.string().uuid().nullable(),
  supplier_invoice_id: z.string().uuid().nullable(),
  supplier_invoice_payment_id: z.string().uuid().nullable(),
  settlement_id: z.string().uuid().nullable(),
  basis: z
    .enum(LINK_BASES)
    .nullable()
    .describe(
      'Why the link exists, as recorded when it was made: user_confirmed, user_created, rule_ocr_reference, rule_amount_date, rule_counterparty, agent_proposed_user_approved, agent_autonomous_within_grant (reserved), client_asserted, import_carried_over, system_derived. Null when not recorded (links before 2026-10-16).',
    ),
  evidence: LinkEvidenceSchema.nullable().describe('What the writer saw: rule_id, reference, score, receipt_id, pending_operation_id, source_system.'),
})

export type VoucherLink = z.infer<typeof VoucherLinkSchema>

type BasisRow = { link_basis?: unknown; link_evidence?: unknown }

function link(kind: VoucherLink['kind'], fields: Partial<VoucherLink>, row: BasisRow): VoucherLink {
  const { basis, evidence } = readLinkBasis(row)
  return {
    kind,
    transaction_id: null,
    via: null,
    document_id: null,
    invoice_id: null,
    invoice_payment_id: null,
    supplier_invoice_id: null,
    supplier_invoice_payment_id: null,
    settlement_id: null,
    ...fields,
    basis,
    evidence,
  }
}

/**
 * The links of one verifikat with their basis. The caller has already read
 * the verifikat for this company; every read here is company-scoped too.
 * Throws on a failed read, so a caller can tell "unknown" from "none".
 */
export async function getVoucherLinks(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<VoucherLink[]> {
  const cap = MAX_VOUCHER_LINKS_PER_KIND
  const [pointers, junction, documents, payments, supplierPayments, settlements] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .order('date', { ascending: true })
      .limit(cap),
    supabase
      .from('transaction_voucher_links')
      .select('transaction_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .order('created_at', { ascending: true })
      .limit(cap),
    supabase
      .from('document_attachments')
      .select('id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .order('created_at', { ascending: true })
      .limit(cap),
    supabase
      .from('invoice_payments')
      .select('id, invoice_id, transaction_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .order('created_at', { ascending: true })
      .limit(cap),
    supabase
      .from('supplier_invoice_payments')
      .select('id, supplier_invoice_id, transaction_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .order('created_at', { ascending: true })
      .limit(cap),
    supabase
      .from('account_reconciliation_settlements')
      .select('settlement_id, link_basis, link_evidence')
      .eq('company_id', companyId)
      .eq('journal_entry_id', journalEntryId)
      .is('undone_at', null)
      .limit(cap),
  ])
  for (const r of [pointers, junction, documents, payments, supplierPayments, settlements]) {
    if (r.error) throw dbError(r.error)
  }

  const links: VoucherLink[] = []
  for (const row of (pointers.data ?? []) as Array<BasisRow & { id: string }>) {
    links.push(link('bank_transaction', { transaction_id: row.id, via: 'pointer' }, row))
  }
  for (const row of (junction.data ?? []) as Array<BasisRow & { transaction_id: string }>) {
    links.push(link('bank_transaction', { transaction_id: row.transaction_id, via: 'voucher_link' }, row))
  }
  for (const row of (documents.data ?? []) as Array<BasisRow & { id: string }>) {
    links.push(link('document', { document_id: row.id }, row))
  }
  for (const row of (payments.data ?? []) as Array<BasisRow & { id: string; invoice_id: string; transaction_id: string | null }>) {
    links.push(
      link('invoice_payment', { invoice_payment_id: row.id, invoice_id: row.invoice_id, transaction_id: row.transaction_id ?? null }, row),
    )
  }
  for (const row of (supplierPayments.data ?? []) as Array<
    BasisRow & { id: string; supplier_invoice_id: string; transaction_id: string | null }
  >) {
    links.push(
      link(
        'supplier_invoice_payment',
        { supplier_invoice_payment_id: row.id, supplier_invoice_id: row.supplier_invoice_id, transaction_id: row.transaction_id ?? null },
        row,
      ),
    )
  }
  for (const row of (settlements.data ?? []) as Array<BasisRow & { settlement_id: string }>) {
    links.push(link('ledger_settlement', { settlement_id: row.settlement_id }, row))
  }
  return links
}

/**
 * The compact form for MCP reads: the identifiers a link has, its basis
 * (null kept: "not recorded" is an answer) and its evidence when there is
 * some. Every identifier keeps its qualified name.
 */
export function toCompactLinks(links: VoucherLink[]): Array<Record<string, unknown>> {
  return links.map((l) => {
    const out: Record<string, unknown> = { kind: l.kind }
    for (const key of [
      'transaction_id',
      'via',
      'document_id',
      'invoice_id',
      'invoice_payment_id',
      'supplier_invoice_id',
      'supplier_invoice_payment_id',
      'settlement_id',
    ] as const) {
      if (l[key] !== null) out[key] = l[key]
    }
    out.basis = l.basis
    if (l.evidence) out.evidence = l.evidence
    return out
  })
}
