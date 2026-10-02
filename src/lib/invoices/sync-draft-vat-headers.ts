import type { SupabaseClient } from '@supabase/supabase-js'
import type { CustomerType } from '@/types'
import {
  deriveInvoiceVatHeader,
  resolveInvoiceVatRules,
  type InvoiceVatTreatmentOverride,
} from '@/lib/invoices/vat-rules'

interface DraftRow {
  id: string
  vat_treatment: string | null
  moms_ruta: string | null
  reverse_charge_text: string | null
  vat_treatment_override: InvoiceVatTreatmentOverride | null
  delivery_country: string | null
  items: { vat_rate: number | null; line_type: string | null }[] | null
}

/**
 * Re-derive the VAT header (treatment, ruta, statutory notice) of a
 * customer's open drafts from the customer as it is now.
 *
 * The header is written from the customer when a draft is created or edited.
 * A draft is not an issued document yet, so when the customer changes under
 * it (typically a VIES check that passes after the draft was made) the draft
 * must follow: otherwise it keeps "25 %" on the page and, once sent, books a
 * 0 % line as momsfri instead of reverse charge, prints no reverse-charge
 * notice, and never reaches ruta 39 or the periodisk sammanställning.
 *
 * Only the header moves. Line rates and amounts are the user's and stay put;
 * a Swedish rate still sitting on a line to a now reverse-charge customer is
 * surfaced by the draft's VAT notice, not rewritten here. Credit notes follow
 * the invoice they credit, and self-billed rows are the counterparty's
 * document, so neither is touched. Issued invoices never are.
 *
 * A draft that states its own treatment (#2906: vat_treatment_override,
 * delivery_country) is re-decided from that statement AND the customer as
 * it is now, through the same resolveInvoiceVatRules the builder uses. When
 * the customer no longer supports it (an intra-EU supply whose buyer VAT
 * number lost its validation), the draft falls back to the customer's
 * treatment and the statement is cleared with it: it never keeps 0 % the
 * facts no longer support, and a delivery_country left behind under a
 * header it no longer explains could not route revenue to 3105 / 3108.
 *
 * Best effort: returns the number of drafts updated and never throws, so a
 * customer write that already succeeded is not reported as failed.
 */
export async function syncDraftVatHeadersForCustomer(
  supabase: SupabaseClient,
  companyId: string,
  customerId: string,
): Promise<number> {
  try {
    const { data: customer } = await supabase
      .from('customers')
      .select('id, customer_type, vat_number, vat_number_validated, country')
      .eq('id', customerId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!customer) return 0

    const { data: drafts } = await supabase
      .from('invoices')
      .select('id, vat_treatment, moms_ruta, reverse_charge_text, vat_treatment_override, delivery_country, items:invoice_items(vat_rate, line_type)')
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .eq('status', 'draft')
      .is('credited_invoice_id', null)
      .eq('is_self_billed', false)
    if (!drafts || drafts.length === 0) return 0

    const { data: settings } = await supabase
      .from('company_settings')
      .select('vat_registered')
      .eq('company_id', companyId)
      .maybeSingle()
    const vatRegistered = settings?.vat_registered !== false

    const current = customer as {
      id: string
      customer_type: CustomerType
      vat_number: string | null
      vat_number_validated: boolean | null
      country: string | null
    }
    const customerDefault = resolveInvoiceVatRules(current)

    let updated = 0
    for (const draft of drafts as DraftRow[]) {
      const lineRates = [
        ...new Set(
          (draft.items ?? [])
            .filter((item) => item.line_type !== 'text')
            .map((item) => item.vat_rate ?? 0),
        ),
      ]
      const stated = draft.vat_treatment_override != null || draft.delivery_country != null
      const resolved = stated
        ? resolveInvoiceVatRules(current, {
            vat_treatment: draft.vat_treatment_override,
            delivery_country: draft.delivery_country,
          })
        : customerDefault
      const fallback = !resolved.ok
      const rules = resolved.ok ? resolved.rules : customerDefault.ok ? customerDefault.rules : null
      if (!rules) continue
      const header = deriveInvoiceVatHeader(rules, lineRates, { vatRegistered })
      if (
        !fallback &&
        header.vat_treatment === draft.vat_treatment &&
        header.moms_ruta === draft.moms_ruta &&
        header.reverse_charge_text === draft.reverse_charge_text
      ) {
        continue
      }
      const update = fallback ? { ...header, vat_treatment_override: null, delivery_country: null } : header
      // status = 'draft' again in the filter: a draft issued between the read
      // and this write keeps the header it was issued with.
      const { error } = await supabase
        .from('invoices')
        .update(update)
        .eq('id', draft.id)
        .eq('company_id', companyId)
        .eq('status', 'draft')
      if (!error) updated++
    }
    return updated
  } catch {
    return 0
  }
}
