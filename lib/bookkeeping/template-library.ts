import type { BookingTemplateCategory, BookingTemplateLibrary, BookingTemplateLibraryLine, VatTreatment } from '@/types'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'

/**
 * Prefix for library template ids when they are mapped into the
 * static BookingTemplate shape used by the transaction picker.
 */
export const LIBRARY_TEMPLATE_PREFIX = 'library:'
export function isLibraryTemplateId(id: string): boolean { return id.startsWith(LIBRARY_TEMPLATE_PREFIX) }

/**
 * Category labels in Swedish for UI display.
 */
export const TEMPLATE_CATEGORY_LABELS: Record<BookingTemplateCategory, string> = {
  eu_trade: 'EU-handel',
  tax_account: 'Skattekonto',
  private_transfer: 'Egna transaktioner',
  salary: 'Lön',
  representation: 'Representation',
  year_end: 'Bokslut',
  vat: 'Moms',
  financial: 'Bank & finans',
  other: 'Övrigt',
}

/**
 * Convert a template's line pattern + total amount into form lines
 * ready for the JournalEntryForm.
 *
 * The algorithm:
 *   1. VAT lines: amount = totalAmount × vat_rate / (1 + vat_rate)
 *   2. Settlement lines: amount = totalAmount (the full payment)
 *   3. Business lines: amount = totalAmount × ratio (cost/revenue net of VAT handled separately)
 *
 * For simple two-line templates (no VAT), the ratio is typically 1.0
 * on both sides and totalAmount is used directly.
 */
export function applyTemplate(
  lines: BookingTemplateLibraryLine[],
  totalAmount: number,
): FormLine[] {
  const result: FormLine[] = []

  for (const line of lines) {
    let amount = 0

    if (line.type === 'vat' && line.vat_rate) {
      // VAT calculated on the total inclusive amount
      amount = Math.round(totalAmount * line.vat_rate / (1 + line.vat_rate) * 100) / 100
    } else if (line.type === 'settlement') {
      amount = Math.round(totalAmount * (line.ratio ?? 1) * 100) / 100
    } else {
      // Business lines: use ratio (default 1.0)
      amount = Math.round(totalAmount * (line.ratio ?? 1) * 100) / 100
    }

    result.push({
      account_number: line.account,
      debit_amount: line.side === 'debit' ? amount.toFixed(2) : '',
      credit_amount: line.side === 'credit' ? amount.toFixed(2) : '',
      line_description: line.label,
    })
  }

  return result
}

/**
 * Scope label for displaying where a template comes from.
 */
export function getTemplateScope(template: {
  is_system: boolean
  team_id: string | null
  company_id: string | null
}): 'system' | 'team' | 'company' {
  if (template.is_system) return 'system'
  if (template.team_id) return 'team'
  return 'company'
}

export const SCOPE_LABELS: Record<ReturnType<typeof getTemplateScope>, string> = {
  system: 'Standard',
  team: 'Team',
  company: 'Företag',
}

function vatRateToTreatment(rate: number): VatTreatment | null {
  if (rate === 0.25) return 'standard_25'
  if (rate === 0.12) return 'reduced_12'
  if (rate === 0.06) return 'reduced_6'
  return null
}

/**
 * Convert a user-created library template to the BookingTemplate shape the
 * transaction TemplatePicker consumes.
 *
 * Only simple shapes (one business line + one settlement line, optionally
 * one VAT line) are returned: complex multi-account templates cannot be
 * expressed as a single debit/credit pair and must be applied via the full
 * journal entry form instead.
 *
 * The id is prefixed with "library:" so downstream code can recognise a
 * library template and look it up through the library APIs rather than the
 * static registry.
 */
export function convertLibraryToBookingTemplate(
  lib: BookingTemplateLibrary,
): BookingTemplate | null {
  if (!Array.isArray(lib.lines)) return null

  const business = lib.lines.filter((l) => l.type === 'business')
  const settlement = lib.lines.filter((l) => l.type === 'settlement')
  const vat = lib.lines.filter((l) => l.type === 'vat')

  if (business.length !== 1 || settlement.length !== 1) return null
  if (business[0].side === settlement[0].side) return null

  const debitLine = business[0].side === 'debit' ? business[0] : settlement[0]
  const creditLine = business[0].side === 'credit' ? business[0] : settlement[0]

  const direction: 'expense' | 'income' = business[0].side === 'debit' ? 'expense' : 'income'

  let vatTreatment: VatTreatment | null = null
  let vatRate = 0
  if (vat.length > 0) {
    const inputVat = vat.find((v) => v.side === 'debit' && v.vat_rate)
      ?? vat.find((v) => v.vat_rate)
    if (inputVat?.vat_rate) {
      const treatment = vatRateToTreatment(inputVat.vat_rate)
      if (treatment) {
        vatTreatment = treatment
        vatRate = inputVat.vat_rate
      }
    }
    // Reverse-charge is recognised by the presence of 2614/2624/2634 (fictitious output VAT)
    if (vat.some((v) => v.account === '2614' || v.account === '2624' || v.account === '2634')) {
      vatTreatment = 'reverse_charge'
    }
  }

  return {
    id: `${LIBRARY_TEMPLATE_PREFIX}${lib.id}`,
    name_sv: lib.name,
    name_en: lib.name,
    group: 'financial',
    direction,
    entity_applicability: lib.entity_type ?? 'all',
    debit_account: debitLine.account,
    credit_account: creditLine.account,
    vat_treatment: vatTreatment,
    vat_rate: vatRate,
    deductibility: 'full',
    special_rules_sv: lib.description || undefined,
    mcc_codes: [],
    keywords: [],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 0,
    auto_match_confidence: 0,
    default_private: false,
    fallback_category: direction === 'expense' ? 'expense_other' : 'income_services',
    description_sv: lib.description || '',
    common: false,
  }
}
