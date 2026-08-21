import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PEPPOL_BIS_BILLING_CUSTOMIZATION_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
  type PeppolInvoiceResult,
} from '@/lib/invoices/peppol-bis-billing'
import type {
  PeppolDeliveryEvidence,
  PeppolVerifiedEvent,
} from '@/lib/invoices/peppol-transport'

type GeneratedPeppolInvoice = Extract<PeppolInvoiceResult, { ok: true }>

export interface PeppolDeliverySummary {
  id: string
  idempotency_key: string
  recipient_scheme: string
  recipient_identifier: string
  xml_sha256: string
  provider: string | null
  provider_submission_id: string | null
  status: string
  status_at: string
  status_detail: string | null
  submitted_at: string | null
  terminal_at: string | null
  evidence_retrieved_at: string | null
  created_at: string
}
export interface StagedPeppolDelivery extends PeppolDeliverySummary {
  invoice_id: string
  filename: string
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function stagePeppolDelivery(args: {
  supabase: SupabaseClient
  companyId: string
  invoiceId: string
  document: GeneratedPeppolInvoice
}): Promise<StagedPeppolDelivery> {
  const { data, error } = await args.supabase.rpc('stage_peppol_delivery', {
    p_company_id: args.companyId,
    p_invoice_id: args.invoiceId,
    p_recipient_scheme: args.document.recipient.scheme,
    p_recipient_identifier: args.document.recipient.identifier,
    p_customization_id: PEPPOL_BIS_BILLING_CUSTOMIZATION_ID,
    p_profile_id: PEPPOL_BIS_BILLING_PROFILE_ID,
    p_filename: args.document.filename,
    p_xml_payload: args.document.xml,
    p_xml_sha256: sha256Hex(args.document.xml),
  })

  if (error) throw error
  if (!data) throw new Error('Failed to stage Peppol delivery: no data returned')
  return data as StagedPeppolDelivery
}

export async function listPeppolDeliverySummaries(args: {
  supabase: SupabaseClient
  companyId: string
  invoiceId: string
}): Promise<PeppolDeliverySummary[]> {
  const { data, error } = await args.supabase.rpc('list_peppol_delivery_summaries', {
    p_company_id: args.companyId,
    p_invoice_id: args.invoiceId,
  })
  if (error) {
    throw new Error(`Failed to list Peppol deliveries: ${error.message}`)
  }
  return (data ?? []) as PeppolDeliverySummary[]
}

export async function persistVerifiedPeppolEvent(args: {
  supabase: SupabaseClient
  companyId: string
  event: PeppolVerifiedEvent
}): Promise<PeppolDeliverySummary> {
  const { event } = args
  if (!event.idempotencyKey) {
    throw new Error('Peppol event idempotency key must be resolved before it is recorded')
  }
  const { data, error } = await args.supabase.rpc('record_peppol_delivery_event', {
    p_company_id: args.companyId,
    p_idempotency_key: event.idempotencyKey,
    p_provider: event.provider,
    p_provider_tenant_id: event.providerTenantId,
    p_provider_submission_id: event.providerSubmissionId,
    p_provider_event_id: event.providerEventId,
    p_provider_event_code: event.eventCode,
    p_normalized_status: event.normalizedStatus,
    p_is_terminal: event.isTerminal,
    p_detail: event.detail,
    p_raw_payload: event.rawPayload,
    p_event_sha256: event.eventSha256,
    p_verification_method: event.verificationMethod,
    p_occurred_at: event.occurredAt,
  })
  if (error || !data) {
    throw new Error(`Failed to record Peppol event: ${error?.message ?? 'unknown error'}`)
  }
  return data as PeppolDeliverySummary
}

export async function persistPeppolEvidence(args: {
  supabase: SupabaseClient
  companyId: string
  idempotencyKey: string
  evidence: PeppolDeliveryEvidence
}): Promise<string> {
  const { evidence } = args
  const { data, error } = await args.supabase.rpc('record_peppol_delivery_evidence', {
    p_company_id: args.companyId,
    p_idempotency_key: args.idempotencyKey,
    p_provider: evidence.provider,
    p_evidence_type: evidence.evidenceType,
    p_evidence_payload: evidence.payload,
    p_document_payload: evidence.exactDocument,
    p_document_sha256: evidence.exactDocumentSha256,
    p_evidence_sha256: evidence.evidenceSha256,
    p_retrieved_at: evidence.retrievedAt,
  })
  if (error || !data) {
    throw new Error(`Failed to record Peppol evidence: ${error?.message ?? 'unknown error'}`)
  }
  return data as string
}
