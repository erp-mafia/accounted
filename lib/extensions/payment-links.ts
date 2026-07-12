import type { SupabaseClient } from '@supabase/supabase-js'
import { extensionRegistry } from '@/lib/extensions/registry'
import type { Invoice } from '@/types'

/**
 * Core-side bridge to an extension-provided invoice payment link service.
 *
 * The send routes call this to auto-fill `invoices.payment_link_url` before
 * the email/PDF render. Core must never import extension code, so the
 * provider is resolved through the registry: an extension that exposes
 * `services.createInvoicePaymentLink` (today: the Stripe extension) becomes
 * the provider. With zero extensions enabled this is a no-op, keeping the
 * extension-free core build and its tests untouched.
 *
 * The provider itself decides eligibility that only it can know (active
 * connection, capability, sandbox, live/test mode) and returns null when it
 * declines. This bridge handles the invoice-shaped eligibility that is true
 * for ANY provider, and never throws: a payment link is a convenience, an
 * invoice send must not fail because a PSP is down.
 */

export const CREATE_INVOICE_PAYMENT_LINK_SERVICE = 'createInvoicePaymentLink'

export interface ProvidedPaymentLink {
  url: string
  externalId: string
}

export type PaymentLinkOutcome =
  | { ok: true; url: string; externalId: string }
  | { ok: false; reason: string }
  | null

interface MinimalLog {
  warn(message: string, ...args: unknown[]): void
}

export interface ApplyPaymentLinkOptions {
  /**
   * Invoice number to use for link creation when the caller holds a fresher
   * value than the invoice object (the v1 route re-reads the number after
   * atomic allocation). The invoice object itself is not touched.
   */
  invoiceNumber?: string | null
  /** Route-specific prefix for the persist-failure warning message. */
  logPrefix?: string
  /** Extra structured context attached to the persist-failure warning. */
  logContext?: Record<string, unknown>
}

export async function maybeCreatePaymentLinkForInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  log?: MinimalLog,
): Promise<PaymentLinkOutcome> {
  // Provider-agnostic eligibility. A manually pasted link always wins; only
  // real, non-credit invoices carry a payment request; the per-invoice
  // toggle opts out entirely.
  if (invoice.payment_link_url) return null
  if (invoice.payment_link_auto === false) return null
  if (invoice.document_type && invoice.document_type !== 'invoice') return null
  if (invoice.credited_invoice_id) return null

  const provider = extensionRegistry
    .getAll()
    .find((ext) => typeof ext.services?.[CREATE_INVOICE_PAYMENT_LINK_SERVICE] === 'function')
  if (!provider) return null

  try {
    const result = (await provider.services![CREATE_INVOICE_PAYMENT_LINK_SERVICE](
      supabase,
      companyId,
      userId,
      invoice,
    )) as ProvidedPaymentLink | null
    if (result && typeof result.url === 'string' && typeof result.externalId === 'string') {
      return { ok: true, url: result.url, externalId: result.externalId }
    }
    return null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log?.warn('payment link provider failed; sending without a link', {
      provider: provider.id,
      invoiceId: invoice.id,
      reason,
    })
    return { ok: false, reason }
  }
}

/**
 * Full send-route flow: create a payment link (if a provider extension is
 * enabled), persist it on the invoices row, and only then mirror it onto the
 * in-memory invoice object so the email button and PDF QR carry it.
 *
 * Shared by the dashboard and v1 send routes. Never throws and never blocks
 * the send: any failure (provider error or persist error) is returned as
 * `{ failure }` for the caller to surface as a non-blocking warning. A link
 * that was created but could not be persisted is deliberately NOT copied onto
 * the invoice: a link rendered on the PDF but missing from the DB could never
 * be matched back to this invoice when the payment event arrives.
 */
export async function applyPaymentLinkToInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  log: MinimalLog,
  opts: ApplyPaymentLinkOptions = {},
): Promise<{ failure: string | null }> {
  const linkInvoice =
    opts.invoiceNumber !== undefined
      ? { ...invoice, invoice_number: opts.invoiceNumber }
      : invoice

  const outcome = await maybeCreatePaymentLinkForInvoice(
    supabase,
    companyId,
    userId,
    linkInvoice,
    log,
  )
  if (!outcome) return { failure: null }
  if (!outcome.ok) return { failure: outcome.reason }

  const { error: persistError } = await supabase
    .from('invoices')
    .update({
      payment_link_url: outcome.url,
      stripe_payment_link_id: outcome.externalId,
    })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
  if (persistError) {
    log.warn(
      `${opts.logPrefix ?? ''}payment link created but not persisted; sending without it`,
      opts.logContext ? { ...opts.logContext, err: persistError } : persistError,
    )
    return { failure: persistError.message }
  }

  invoice.payment_link_url = outcome.url
  invoice.stripe_payment_link_id = outcome.externalId
  return { failure: null }
}
