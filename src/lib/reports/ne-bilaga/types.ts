// NE-bilaga rutor (NE appendix boxes). Which BAS accounts feed each one:
// NE_ACCOUNT_RANGES in ne-engine.ts (BAS kopplingstabell NE_EJ_K1).
export interface NEDeclarationRutor {
  R1: number   // Försäljning och utfört arbete samt övriga momspliktiga intäkter
  R2: number   // Momsfria intäkter
  R3: number   // Bil- och bostadsförmån m.m. (no BAS account)
  R4: number   // Ränteintäkter m.m.
  R5: number   // Varor och legoarbeten
  R6: number   // Övriga externa kostnader
  R7: number   // Anställd personal
  R8: number   // Räntekostnader m.m.
  R9: number   // Av- och nedskrivningar byggnader och markanläggningar
  R10: number  // Av- och nedskrivningar maskiner, inventarier, immateriella
  R11: number  // Bokfört resultat (R1+R2+R3+R4 - R5..R10)
}

/** A ruta an account balance is reported in: every ruta except the computed R11. */
export type NERuta = Exclude<keyof NEDeclarationRutor, 'R11'>

/**
 * One range of BAS accounts and the ruta its balance goes to. `income` takes
 * a credit balance, `cost` a debit balance: the same ruta for most ranges,
 * R4/R8 where BAS marks the accounts (+)/(-) because one account can be
 * either an income or a cost.
 */
export interface NEAccountRange {
  start: string
  end: string
  income: NERuta
  cost: NERuta
}

// NE declaration response
export interface NEDeclaration {
  fiscalYear: {
    id: string
    name: string
    start: string
    end: string
    isClosed: boolean
  }
  rutor: NEDeclarationRutor
  // Detailed breakdown per ruta
  breakdown: Record<keyof NEDeclarationRutor, {
    accounts: Array<{
      accountNumber: string
      accountName: string
      amount: number
    }>
    total: number
  }>
  // Company info for SRU (orgNumber for enskild firma is the owner's personnummer)
  companyInfo: {
    companyName: string
    orgNumber: string | null
    addressLine1: string | null
    postalCode: string | null
    city: string | null
    email: string | null
  }
  // Warnings
  warnings: string[]
  // The booked result (öre) from the same pre-closing trial balance: what R11
  // must equal, up to the whole-krona rounding of R1-R10.
  bookedResult: number
  // Why the SRU file is refused (an account without a ruta, R11 differing
  // from bookedResult, or a booked periodiseringsfond). Empty when it can be
  // filed; each text is also in warnings.
  sruBlockers: string[]
}

// A complete SRU submission: two files (INFO.SRU + BLANKETTER.SRU), ISO 8859-1 encoded by the route.
export interface SRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

