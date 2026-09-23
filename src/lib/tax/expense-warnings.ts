/**
 * Expense warnings for non-deductible or partially deductible items
 * Based on Swedish tax law and Kammarrätten rulings
 */

export interface ExpenseWarning {
  category: string
  warningLevel: 'info' | 'warning' | 'danger'
  message: string
  legalBasis?: string
}

/**
 * Meal/representation keyword pattern. Exported so channel intake (the
 * WhatsApp representation-question trigger) reuses the exact same base
 * heuristic instead of drifting its own copy.
 */
export const MEAL_PATTERN = /restaurang|lunch|middag|dinner|café|fika/i

const warningPatterns: {
  pattern: RegExp
  warning: ExpenseWarning
}[] = [
  {
    pattern: /kläder|clothes|mode|fashion|outfit/i,
    warning: {
      category: 'Kläder',
      warningLevel: 'danger',
      message: 'Kläder är normalt inte avdragsgilla, även om de används i arbetet',
      legalBasis: 'RÅ 1988 ref. 35',
    },
  },
  {
    pattern: /kosmetika|smink|makeup|hudvård|skincare|beauty/i,
    warning: {
      category: 'Kosmetika',
      warningLevel: 'warning',
      message: 'Kosmetika är normalt inte avdragsgillt. Undantag kan gälla för professionella artister.',
      legalBasis: 'Skatteverkets ställningstagande',
    },
  },
  {
    pattern: /gym|träning|fitness|sport/i,
    warning: {
      category: 'Träning',
      warningLevel: 'danger',
      message: 'Gymkort och träningsavgifter är inte avdragsgilla som personlig kostnad',
      legalBasis: 'IL 9 kap 2§',
    },
  },
  {
    pattern: /frisör|hår|salon|barber/i,
    warning: {
      category: 'Frisör',
      warningLevel: 'warning',
      message: 'Frisörbesök är normalt privata kostnader och inte avdragsgilla',
    },
  },
  {
    pattern: MEAL_PATTERN,
    warning: {
      category: 'Representation',
      warningLevel: 'warning',
      message: 'Måltider kan vara avdragsgilla som representation. Inkomstskatteavdraget togs bort 2017, men momsen är avdragsgill på upp till 300 kr/person (exkl. moms) enligt ML 13 kap 24-25 §§.',
      legalBasis: 'IL 16 kap 2 §, ML 13 kap 24-25 §§',
    },
  },
  {
    pattern: /resa|flyg|flight|tåg|train|hotel|hotell/i,
    warning: {
      category: 'Resor',
      warningLevel: 'info',
      message: 'Resor kan vara avdragsgilla om de är nödvändiga för verksamheten. Dokumentera syftet!',
    },
  },
  {
    pattern: /presenter|gift|gåva/i,
    warning: {
      category: 'Gåvor',
      warningLevel: 'warning',
      message: 'Reklamgåvor är avdragsgilla upp till 300 kr per mottagare. Representationsgåvor max 180 kr.',
      legalBasis: 'IL 16 kap 2§',
    },
  },
  {
    pattern: /mobil|telefon|phone|iphone|samsung/i,
    warning: {
      category: 'Telefon',
      warningLevel: 'info',
      message: 'Arbetstelefon är avdragsgillt. Vid blandad användning, endast den yrkesmässiga delen.',
    },
  },
  {
    pattern: /dator|laptop|computer|mac|ipad/i,
    warning: {
      category: 'Dator',
      warningLevel: 'info',
      message: 'Datorer för yrkesmässig användning är avdragsgilla. Vid blandad användning ska fördelning göras.',
    },
  },
]

/**
 * Check if an expense description triggers any warnings
 */
export function checkExpenseWarnings(description: string): ExpenseWarning[] {
  const warnings: ExpenseWarning[] = []

  for (const { pattern, warning } of warningPatterns) {
    if (pattern.test(description)) {
      warnings.push(warning)
    }
  }

  return warnings
}

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
