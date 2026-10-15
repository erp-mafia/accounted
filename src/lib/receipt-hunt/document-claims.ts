import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Who already holds a document: a link waiting for approval, or a bank
 * transaction it is attached to. One document normally backs one purchase,
 * but an invoice paid in two instalments legitimately backs two bank rows,
 * so a claim on a bank transaction is something to show, not something to
 * refuse. A waiting link to another verifikat is different: see
 * conflictingVoucherClaims.
 */
export interface DocumentClaim {
  document_id: string
  /** The waiting link proposal, when the claim is a pending one. */
  operation_id: string | null
  transaction_id: string | null
  journal_entry_id: string | null
}

const LINK_OPERATION_TYPES = ['attach_document_to_transaction', 'link_document_to_voucher', 'link_documents_to_vouchers'] as const
const WAITING_STATUSES = ['pending', 'committing'] as const

interface LinkParams {
  document_id?: string
  transaction_id?: string
  journal_entry_id?: string
  /** copy: the row links a new copy of the document, never the document itself (crm#1207). */
  links?: { document_id?: string; journal_entry_id?: string; copy?: boolean }[]
}

/** Every claim on the given documents, keyed by document id. */
export async function loadDocumentClaims(supabase: SupabaseClient, companyId: string, documentIds: string[]): Promise<Map<string, DocumentClaim[]>> {
  return (await loadDocumentClaimsAndWaitingLinks(supabase, companyId, documentIds)).claims
}

/**
 * loadDocumentClaims, plus how many single link_document_to_voucher
 * proposals the company already has waiting, read from the same rows. An
 * agent staging the third one in a row is told about the bulk tool, which
 * stages them as one approval (crm#1207: 131 single links approved one by
 * one).
 */
export async function loadDocumentClaimsAndWaitingLinks(
  supabase: SupabaseClient,
  companyId: string,
  documentIds: string[],
): Promise<{ claims: Map<string, DocumentClaim[]>; waitingVoucherLinks: number }> {
  const wanted = new Set(documentIds)
  const claims = new Map<string, DocumentClaim[]>()
  if (wanted.size === 0) return { claims, waitingVoucherLinks: 0 }
  const add = (claim: DocumentClaim) => claims.set(claim.document_id, [...(claims.get(claim.document_id) ?? []), claim])

  const [pending, attached] = await Promise.all([
    fetchAllRows<{ id: string; operation_type?: string; params: LinkParams | null }>((range) =>
      supabase
        .from('pending_operations')
        .select('id, operation_type, params')
        .eq('company_id', companyId)
        .in('operation_type', [...LINK_OPERATION_TYPES])
        .in('status', [...WAITING_STATUSES])
        .order('id', { ascending: true })
        .range(range.from, range.to),
    ),
    supabase.from('transactions').select('id, document_id').eq('company_id', companyId).in('document_id', [...wanted]),
  ])
  if (attached.error) throw new Error(`Failed to read attached documents: ${attached.error.message}`)

  for (const op of pending) {
    const p = op.params ?? {}
    if (p.document_id && wanted.has(p.document_id)) {
      add({ document_id: p.document_id, operation_id: op.id, transaction_id: p.transaction_id ?? null, journal_entry_id: p.journal_entry_id ?? null })
    }
    for (const link of p.links ?? []) {
      // A copy row leaves the document itself free: approving it archives a
      // new row for its verifikat, so it claims nothing another link could
      // collide with.
      if (link.copy === true) continue
      if (link.document_id && wanted.has(link.document_id)) {
        add({ document_id: link.document_id, operation_id: op.id, transaction_id: null, journal_entry_id: link.journal_entry_id ?? null })
      }
    }
  }
  for (const row of (attached.data ?? []) as { id: string; document_id: string }[]) {
    add({ document_id: row.document_id, operation_id: null, transaction_id: row.id, journal_entry_id: null })
  }
  const waitingVoucherLinks = pending.filter((op) => op.operation_type === 'link_document_to_voucher').length
  return { claims, waitingVoucherLinks }
}

/**
 * The waiting proposals that link the document straight to a verifikat
 * other than `journalEntryId`. At most one of them and the link being staged
 * can commit: document_attachments.journal_entry_id holds one verifikat, and
 * enforce_document_journal_entry_immutability refuses every later change of
 * it. Staging the second link only moved that refusal to the approval
 * (crm#1158), so a voucher link refuses at staging when this is non-empty.
 */
export function conflictingVoucherClaims(claims: DocumentClaim[], journalEntryId: string): DocumentClaim[] {
  return claims.filter((c) => c.operation_id !== null && c.journal_entry_id !== null && c.journal_entry_id !== journalEntryId)
}

/**
 * The warning for staging a link with a document something else already
 * holds, or null. `target` is the link being staged, so it never warns
 * about itself (a retry of the same link is the idempotency path's job).
 *
 * Bank transactions alone may share an invoice paid in several parts, and
 * both links commit. Once a verifikat is on either side, only one verifikat
 * can ever hold the document, so the warning never invites approving both.
 */
export function sharedDocumentWarning(claims: DocumentClaim[], target: { transaction_id?: string; journal_entry_id?: string }): string | null {
  const others = claims.filter((c) =>
    !(target.transaction_id && c.transaction_id === target.transaction_id) &&
    !(target.journal_entry_id && c.journal_entry_id === target.journal_entry_id))
  if (others.length === 0) return null
  const where = others.map((c) => c.operation_id
    ? `förslag ${c.operation_id.slice(0, 8)}${c.transaction_id ? ` (banktransaktion ${c.transaction_id.slice(0, 8)})` : c.journal_entry_id ? ` (verifikat ${c.journal_entry_id.slice(0, 8)})` : ''}`
    : `banktransaktion ${c.transaction_id!.slice(0, 8)}`)
  const verifikatInvolved = target.journal_entry_id !== undefined || others.some((c) => c.journal_entry_id !== null)
  if (verifikatInvolved) {
    return `Samma underlag är redan kopplat eller föreslaget: ${where.join('; ')}. Ett underlag kan bara kopplas till en verifikation, så bara en av verifikationerna kan få det. Ett kontoutdrag som täcker flera transaktioner, eller en rättelse som vilar på originalets faktura, får en egen kopia per verifikation: koppla en exakt kopia till den andra verifikationen, annars avvisa det som är fel.`
  }
  return `Samma underlag är redan kopplat eller föreslaget: ${where.join('; ')}. Ett underlag hör normalt till ett köp. Godkänn båda bara om det är en faktura som betalats i flera delar, annars avvisa det som är fel.`
}
