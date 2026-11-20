/**
 * Meal/representation keyword pattern: the base heuristic of channel intake's
 * representation question (the WhatsApp trigger extends it with venue words).
 */
export const MEAL_PATTERN = /restaurang|lunch|middag|dinner|café|fika/i

/**
 * Get category suggestions based on description
 */
export function suggestCategory(description: string): string | null {
  const categoryPatterns: { pattern: RegExp; category: string }[] = [
    { pattern: /spotify|netflix|adobe|software|app store/i, category: 'expense_software' },
    { pattern: /kamera|camera|ljud|mikrofon|ring light|studio/i, category: 'expense_equipment' },
    { pattern: /flyg|tåg|hotel|taxi|uber/i, category: 'expense_travel' },
    { pattern: /facebook ads|google ads|instagram|marknadsföring|marketing/i, category: 'expense_marketing' },
    { pattern: /revisor|advokat|konsult|accountant|lawyer/i, category: 'expense_professional_services' },
    { pattern: /kurs|utbildning|course|workshop/i, category: 'expense_education' },
    { pattern: /kontor|office|skriv|hyra/i, category: 'expense_office' },
    { pattern: /bankavgift|bankfee|monthly fee|kontoavgift|serviceavgift/i, category: 'expense_bank_fees' },
    { pattern: /kortavgift|card fee|annual fee/i, category: 'expense_card_fees' },
    { pattern: /valutaväxling|currency|exchange|FX fee/i, category: 'expense_currency_exchange' },
  ]

  for (const { pattern, category } of categoryPatterns) {
    if (pattern.test(description)) {
      return category
    }
  }

  return null
}

/**
 * Get display name for category
 */
export function getCategoryDisplayName(category: string): string {
  const names: Record<string, string> = {
    income_services: 'Tjänster',
    income_products: 'Produkter',
    income_other: 'Övriga intäkter',
    expense_equipment: 'Utrustning',
    expense_software: 'Programvara',
    expense_travel: 'Resor',
    expense_office: 'Kontor',
    expense_marketing: 'Marknadsföring',
    expense_professional_services: 'Konsulter',
    expense_education: 'Utbildning',
    expense_bank_fees: 'Bankavgift',
    expense_card_fees: 'Kortavgift',
    expense_currency_exchange: 'Valutaväxling',
    expense_other: 'Övriga kostnader',
    private: 'Privat',
    uncategorized: 'Ej bokförd',
  }

  return names[category] || category
}
