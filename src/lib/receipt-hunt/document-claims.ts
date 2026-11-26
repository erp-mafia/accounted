import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'

/**
 * Who already holds a document: a link waiting for approval, or a bank
 * transaction it is attached to. One document backs one purchase and sits on
 * one bank row at a time: attaching it to another unbooked row moves it
 * there (lib/transactions/document-attach.ts, crm#1950), so a claim on a
 * bank transaction is something to show, not something to refuse. An invoice
 * paid in two instalments gets a copy on the second verifikat. A waiting
 * link to another verifikat is different: see conflictingVoucherClaims.
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
  /** A single link staged as a copy claims nothing either (crm#1171 item 9). */
  copy?: boolean
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

  // The bank rows holding the documents, in slices of ID_READ_CHUNK: the ids
  // travel in the GET query string, which the gateway refuses past its
  // limit, and gnubok_link_documents_to_vouchers asks about up to 300
  // documents. A slice is not paged: a document sits on one bank row at a
  // time, so 100 documents stay far under the 1000-row cap.
  const readAttached = async () => {
    const rows: { id: string; document_id: string }[] = []
    for (const ids of chunk([...wanted], ID_READ_CHUNK)) {
      const { data, error } = await supabase.from('transactions').select('id, document_id').eq('company_id', companyId).in('document_id', ids)
      if (error) throw new Error(`Failed to read attached documents: ${error.message}`)
      rows.push(...((data ?? []) as { id: string; document_id: string }[]))
    }
    return rows
  }

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
    readAttached(),
  ])

  for (const op of pending) {
    const p = op.params ?? {}
    if (p.document_id && wanted.has(p.document_id) && p.copy !== true) {
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
  for (const row of attached) {
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
 * Between bank transactions the document moves: the attach approved last
 * holds it and the other row is left without, so the warning says so and
 * never invites approving both (an invoice paid in several parts gets a copy
 * on the second verifikat). Once a verifikat is on either side, only one
 * verifikat can ever hold the document.
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
  // On another row already: this approval moves it. Only proposed there: the later approval does.
  const outcome = others.some((c) => c.operation_id === null)
    ? 'godkänns det här flyttas underlaget hit och den andra transaktionen blir utan'
    : 'godkänns båda hamnar underlaget på den transaktion som godkänns sist'
  return `Samma underlag är redan kopplat eller föreslaget: ${where.join('; ')}. Ett underlag hör till ett köp och sitter på en banktransaktion i taget: ${outcome}. Avvisa det som är fel. En faktura som betalats i flera delar: bokför transaktionerna var för sig och koppla en exakt kopia av underlaget till den andra verifikationen.`
}
