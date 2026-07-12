// NE-bilaga rutor (NE appendix boxes)
export interface NEDeclarationRutor {
  R1: number   // Försäljning med 25% moms (3000-3499 excl 3100)
  R2: number   // Momsfria intäkter (3100, 3970, 3980)
  R3: number   // Bil/bostadsförmån (3200)
  R4: number   // Ränteintäkter (8310-8330)
  R5: number   // Varuinköp (4000-4990)
  R6: number   // Övriga kostnader (5000-6990, 7970)
  R7: number   // Lönekostnader (7000-7699)
  R8: number   // Räntekostnader (8400-8499)
  R9: number   // Avskrivningar fastighet (7820)
  R10: number  // Avskrivningar övrigt (7700-7899 excl 7820)
  R11: number  // Årets resultat (beräknat)
}

// NE account mapping configuration
export interface NEAccountMapping {
  ruta: keyof NEDeclarationRutor
  description: string
  accountRanges: Array<{
    start: string
    end: string
    exclude?: string[]
  }>
  isExpense: boolean  // true = debit normal, false = credit normal
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
}

// A complete SRU submission: two files (INFO.SRU + BLANKETTER.SRU), ISO 8859-1 encoded by the route.
export interface SRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

// Labels for NE rutor
export const NE_RUTA_LABELS: Record<keyof NEDeclarationRutor, string> = {
  R1: 'Försäljning med moms (25%)',
  R2: 'Momsfria intäkter',
  R3: 'Bil/bostadsförmån',
  R4: 'Ränteintäkter',
  R5: 'Varuinköp',
  R6: 'Övriga kostnader',
  R7: 'Lönekostnader',
  R8: 'Räntekostnader',
  R9: 'Avskrivningar fastighet',
  R10: 'Avskrivningar övriga tillgångar',
  R11: 'Årets resultat'
}
