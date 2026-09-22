import type { McpResource } from './types'
import { getAvailableVatRates, getPermittedVatRates, getVatRules } from '@/lib/invoices/vat-rules'
import type { CustomerType } from '@/types'

const CUSTOMER_TYPES: CustomerType[] = ['individual', 'swedish_business', 'eu_business', 'non_eu_business']

export const vatTreatmentsResource: McpResource = {
  uri: 'Accounted://settings/vat-treatments',
  name: 'VAT Treatments',
  description: 'Available VAT treatments and rates per customer type, and the resulting moms ruta on the VAT declaration. Use before creating invoices to pick the right VAT rate.',
  mimeType: 'application/json',
  // Two rate sets, always both, always labelled. Publishing only the default
  // set (the single locked 0% for a foreign business) told an agent that 0% was
  // the only lawful rate, so it would never attempt a lawful Stockholm hotel
  // night for a German company; publishing only the lawful set would invite
  // 25% on a plain consulting invoice to that same company. The pair plus the
  // swedish_vat_to_foreign_business note below is what an agent needs to pick
  // correctly: start from default_rates, deviate only for a supply that the
  // note names. Read on demand via resources/read, so this costs nothing in the
  // tools/list payload budget.
  read: async () => {
    const matrix: Record<string, unknown> = {}

    for (const ct of CUSTOMER_TYPES) {
      matrix[ct] = {
        unvalidated_vat: {
          default_rates: getAvailableVatRates(ct, false),
          permitted_rates: getPermittedVatRates(ct, false),
          default_rule: getVatRules(ct, false),
        },
        validated_vat: {
          default_rates: getAvailableVatRates(ct, true),
          permitted_rates: getPermittedVatRates(ct, true),
          default_rule: getVatRules(ct, true),
        },
      }
    }

    return {
      treatments: ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt'],
      by_customer_type: matrix,
      notes: {
        rate_sets: 'default_rates is what a line should normally use; permitted_rates is everything the invoice tools accept. Identical for Swedish customers; wider for a foreign business, see swedish_vat_to_foreign_business.',
        swedish_vat_to_foreign_business: 'Huvudregeln (ML 6 kap. 34 §) taxes a B2B service where the buyer is established, so 0% is the default for a VAT-validated EU business and for a non-EU business. Supplies taxed where they are performed carry Swedish VAT even to a foreign business: hotel and restaurang/catering 12%, persontransport and admission to cultural or sporting events 6%, fastighetstjänst and short-term vehicle hire 25%. Set such a rate on the line only for that kind of supply; consulting, licensing and other huvudregel services stay at 0%.',
        eu_business_validated: 'Reverse charge is the default: invoice 0%, customer self-accounts, moms ruta 39.',
        non_eu_business: 'Export is the default: invoice 0%, no Swedish VAT, moms ruta 40.',
        mixed_rate: 'Invoice line items can have individual VAT rates; the engine generates per-rate lines.',
      },
    }
  },
}
