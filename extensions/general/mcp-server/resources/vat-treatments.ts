import type { McpResource } from './types'
import { getAvailableVatRates, getVatRules } from '@/lib/invoices/vat-rules'
import type { CustomerType } from '@/types'

const CUSTOMER_TYPES: CustomerType[] = ['individual', 'swedish_business', 'eu_business', 'non_eu_business']

export const vatTreatmentsResource: McpResource = {
  uri: 'Accounted://settings/vat-treatments',
  name: 'VAT Treatments',
  description: 'Available VAT treatments and rates per customer type, and the resulting moms ruta on the VAT declaration. Use before creating invoices to pick the right VAT rate.',
  mimeType: 'application/json',
  read: async () => {
    const matrix: Record<string, unknown> = {}

    for (const ct of CUSTOMER_TYPES) {
      matrix[ct] = {
        unvalidated_vat: {
          rates: getAvailableVatRates(ct, false),
          default_rule: getVatRules(ct, false),
        },
        validated_vat: {
          rates: getAvailableVatRates(ct, true),
          default_rule: getVatRules(ct, true),
        },
      }
    }

    return {
      treatments: ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt'],
      by_customer_type: matrix,
      notes: {
        eu_business_validated: 'Reverse charge applies: invoice 0%, customer self-accounts via moms ruta 39.',
        non_eu_business: 'Export: invoice 0%, no Swedish VAT, moms ruta 40.',
        mixed_rate: 'Invoice line items can have individual VAT rates; the engine generates per-rate lines.',
      },
    }
  },
}
