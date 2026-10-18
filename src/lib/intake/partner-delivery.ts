/**
 * The partner door into the Inkorg: POST /api/v1/companies/{id}/inbox-items.
 *
 * A partner (a digital mailbox such as Billo) delivers a supplier invoice or
 * a receipt the way a person uploads one: through the invoice-inbox
 * extension's shared pipeline (content dedupe, extraction, Arkiv), among
 * the Inkorg's open items for a person or a granted agent to book. Nothing is booked
 * on arrival (founder decision 2026-10-15: every door goes through the
 * Inkorg; booking without a person comes back later as a grant).
 *
 * Core cannot import @/extensions (CI guard), so the v1 route reaches the
 * pipeline through the registry's `services` channel. This module holds the
 * shared shapes, so the extension and the route agree on the contract
 * without core ever importing the extension (same pattern as
 * lib/bank-sync/trigger-sync-contract.ts), plus the business-key lookup the
 * route runs before filing anything.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { InboxChannelContext } from '@/types'

const log = createLogger('intake/partner-delivery')

/** The extension that owns the pipeline, and the service it registers. */
export const INVOICE_INBOX_EXTENSION_ID = 'invoice-inbox'
export const FILE_INBOX_DELIVERY_SERVICE = 'fileInboxDelivery'

/** The canonical door id of a partner delivery (ARRIVAL_SOURCES). */
export const PARTNER_DELIVERY_SOURCE = 'partner_api' as const

/** What a delivery may declare it is: the same two kinds as the +lev / +ver address tags. */
export const INBOX_DELIVERY_KINDS = ['supplier_invoice', 'receipt'] as const
export type InboxDeliveryKind = (typeof INBOX_DELIVERY_KINDS)[number]

export interface InboxDeliveryInput {
  userId: string
  companyId: string
  file: { name: string; buffer: ArrayBuffer; type: string }
  kindHint?: InboxDeliveryKind | null
  /** Shown as the item's sender (email_from), the way a Peppol item shows its supplier. */
  senderName?: string | null
  subject?: string | null
  /** ISO timestamp the partner received it; the item shows it as its arrival time. */
  receivedAt?: string | null
  channelContext: InboxChannelContext
}

export interface InboxDeliveryResult {
  document_id: string
  inbox_item_id: string
  /** True when the same content was already in the Inkorg and that item was returned. */
  deduplicated: boolean
}

export type FileInboxDelivery = (
  supabase: SupabaseClient,
  input: InboxDeliveryInput,
) => Promise<InboxDeliveryResult>

/** The invoice-inbox extension's registry services, as the v1 route reads them. */
export interface InvoiceInboxServices {
  fileInboxDelivery: FileInboxDelivery
}

/** The channel_context a partner delivery is filed with. */
export function partnerChannelContext(params: {
  keyLabel: string | null | undefined
  externalRef: string | null | undefined
}): InboxChannelContext {
  return {
    channel: PARTNER_DELIVERY_SOURCE,
    intake_source: PARTNER_DELIVERY_SOURCE,
    partner_key_label: params.keyLabel?.trim() ? params.keyLabel.trim().slice(0, 200) : null,
    external_ref: params.externalRef ?? null,
  }
}

/** A delivery already recorded under the partner's external_ref. */
export interface PartnerDeliveryHit {
  arrival_id: string
  document_id: string | null
  inbox_item_id: string | null
  /** SHA-256 of what that delivery archived, when known. */
  original_sha256: string | null
}

/**
 * The delivery recorded under (company, 'partner_api', external_ref), with
 * what it produced. The arrival is the business key: arrivals are unique on
 * (company_id, source, source_ref), so a repeated external_ref resolves to
 * the first delivery.
 *
 * Best effort like the arrivals themselves: a failed read logs and answers
 * null, so the delivery proceeds and the pipeline's content dedupe still
 * returns the existing item for the same file. Refusing the delivery would
 * keep underlag out of the Inkorg for as long as the read fails.
 */
export async function findPartnerDelivery(
  supabase: SupabaseClient,
  companyId: string,
  externalRef: string,
): Promise<PartnerDeliveryHit | null> {
  try {
    const { data, error } = await supabase
      .from('arrivals')
      .select('id, original_sha256')
      .eq('company_id', companyId)
      .eq('source', PARTNER_DELIVERY_SOURCE)
      .eq('source_ref', externalRef)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const arrival = data as { id: string; original_sha256: string | null } | null
    if (!arrival) return null

    const { data: outputs, error: outputsError } = await supabase
      .from('arrival_outputs')
      .select('output_kind, output_id, position')
      .eq('company_id', companyId)
      .eq('arrival_id', arrival.id)
      .order('position', { ascending: true })
    if (outputsError) throw new Error(outputsError.message)
    const rows = (outputs as Array<{ output_kind: string; output_id: string }> | null) ?? []
    return {
      arrival_id: arrival.id,
      document_id: rows.find((o) => o.output_kind === 'document')?.output_id ?? null,
      inbox_item_id: rows.find((o) => o.output_kind === 'inbox_item')?.output_id ?? null,
      original_sha256: arrival.original_sha256,
    }
  } catch (err) {
    log.warn('partner delivery lookup failed; filing through content dedupe', {
      companyId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
