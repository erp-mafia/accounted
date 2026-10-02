import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Who already holds a document: a link waiting for approval, or a bank
 * transaction it is attached to. One document normally backs one purchase,
 * but an invoice paid in two instalments legitimately backs two bank rows,
 * so a claim is something to show, not something to refuse.
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
  links?: { document_id?: string; journal_entry_id?: string }[]
}

/** Every claim on the given documents, keyed by document id. */
export async function loadDocumentClaims(supabase: SupabaseClient, companyId: string, documentIds: string[]): Promise<Map<string, DocumentClaim[]>> {
  const wanted = new Set(documentIds)
  const claims = new Map<string, DocumentClaim[]>()
  if (wanted.size === 0) return claims
  const add = (claim: DocumentClaim) => claims.set(claim.document_id, [...(claims.get(claim.document_id) ?? []), claim])

  const [pending, attached] = await Promise.all([
    fetchAllRows<{ id: string; params: LinkParams | null }>((range) =>
      supabase
        .from('pending_operations')
        .select('id, params')
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
      if (link.document_id && wanted.has(link.document_id)) {
        add({ document_id: link.document_id, operation_id: op.id, transaction_id: null, journal_entry_id: link.journal_entry_id ?? null })
      }
    }
  }
  for (const row of (attached.data ?? []) as { id: string; document_id: string }[]) {
    add({ document_id: row.document_id, operation_id: null, transaction_id: row.id, journal_entry_id: null })
  }
  return claims
}

/**
 * The warning for staging a link with a document something else already
 * holds, or null. `target` is the link being staged, so it never warns
 * about itself (a retry of the same link is the idempotency path's job).
 */
export function sharedDocumentWarning(claims: DocumentClaim[], target: { transaction_id?: string; journal_entry_id?: string }): string | null {
  const others = claims.filter((c) =>
    !(target.transaction_id && c.transaction_id === target.transaction_id) &&
    !(target.journal_entry_id && c.journal_entry_id === target.journal_entry_id))
  if (others.length === 0) return null
  const where = others.map((c) => c.operation_id
    ? `förslag ${c.operation_id.slice(0, 8)}${c.transaction_id ? ` (banktransaktion ${c.transaction_id.slice(0, 8)})` : c.journal_entry_id ? ` (verifikat ${c.journal_entry_id.slice(0, 8)})` : ''}`
    : `banktransaktion ${c.transaction_id!.slice(0, 8)}`)
  return `Samma underlag är redan kopplat eller föreslaget: ${where.join('; ')}. Ett underlag hör normalt till ett köp. Godkänn båda bara om det är en faktura som betalats i flera delar, annars avvisa det som är fel.`
}
