import type { EntityType } from '@/types'

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

/**
 * NE-bilaga balansräkning (sammandrag), B1-B16, at the end of the
 * räkenskapsår. Which BAS accounts feed each one: NE_BALANCE_RANGES in
 * ne-engine.ts (BAS kopplingstabell NE_EJ_K1). B10 is the form's
 * "Eget kapital (tillgångar - skulder)": assets less B11-B16.
 */
export interface NEBalansRutor {
  B1: number   // Immateriella anläggningstillgångar
  B2: number   // Byggnader och markanläggningar
  B3: number   // Mark och andra tillgångar som inte får skrivas av
  B4: number   // Maskiner och inventarier
  B5: number   // Övriga anläggningstillgångar
  B6: number   // Varulager
  B7: number   // Kundfordringar
  B8: number   // Övriga fordringar
  B9: number   // Kassa och bank
  B10: number  // Eget kapital (tillgångar - skulder)
  B11: number  // Obeskattade reserver
  B12: number  // Avsättningar
  B13: number  // Låneskulder
  B14: number  // Skatteskulder (BAS: nothing is reported here for an enskild firma)
  B15: number  // Leverantörsskulder
  B16: number  // Övriga skulder
}

export type NEBalansRuta = keyof NEBalansRutor

/** B1-B16 as the form names them (Skatteverket's labels, Swedish in every locale). */
export const NE_BALANS_LABELS: Record<NEBalansRuta, string> = {
  B1: 'Immateriella anläggningstillgångar',
  B2: 'Byggnader och markanläggningar',
  B3: 'Mark och andra tillgångar som inte får skrivas av',
  B4: 'Maskiner och inventarier',
  B5: 'Övriga anläggningstillgångar',
  B6: 'Varulager',
  B7: 'Kundfordringar',
  B8: 'Övriga fordringar',
  B9: 'Kassa och bank',
  B10: 'Eget kapital (tillgångar - skulder)',
  B11: 'Obeskattade reserver',
  B12: 'Avsättningar',
  B13: 'Låneskulder',
  B14: 'Skatteskulder',
  B15: 'Leverantörsskulder',
  B16: 'Övriga skulder',
}

/** The asset rows B1-B9 and the rows B11-B16 that B10 is the difference of. */
export const NE_ASSET_RUTOR: readonly NEBalansRuta[] = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']
export const NE_LIABILITY_RUTOR: readonly NEBalansRuta[] = ['B11', 'B12', 'B13', 'B14', 'B15', 'B16']

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

/** NE-bilaga sida 2 rows the books give, whole kronor. */
export interface NESida2Rutor {
  /** Bokfört resultat, carried over from R11. */
  R12: number
  /** Bokförda kostnader som inte ska dras av. */
  R13: number
  /** Bokförda intäkter som inte ska tas upp. */
  R14: number
}

/** Skatteverket's labels for the rows above (SKV 2161), Swedish in every locale. */
export const NE_SIDA2_LABELS: Record<keyof NESida2Rutor, string> = {
  R12: 'Bokfört resultat',
  R13: 'Bokförda kostnader som inte ska dras av',
  R14: 'Bokförda intäkter som inte ska tas upp',
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
  // Balansräkning B1-B16 at the year's end, with the accounts behind each
  // row (B10 has none: it is the difference).
  balans: NEBalansRutor
  balansBreakdown: Record<NEBalansRuta, {
    accounts: Array<{
      accountNumber: string
      accountName: string
      amount: number
    }>
    total: number
  }>
  // Sida 2, the rows the books give: R12 is R11 carried over; R13 and R14
  // are the year's tax adjustments (lib/reports/tax-adjustments.ts), with
  // the accounts and saved figures behind them. R15-R28 are the owner's.
  sida2: NESida2Rutor
  sida2Breakdown: Record<'R13' | 'R14', {
    items: Array<{ accountNumber: string | null; description: string; amount: number }>
    total: number
  }>
  // Company info for SRU (orgNumber for enskild firma is the owner's personnummer)
  companyInfo: {
    companyName: string
    orgNumber: string | null
    entityType: EntityType
    addressLine1: string | null
    postalCode: string | null
    city: string | null
    email: string | null
  }
  // Warnings
  warnings: string[]
  // The booked result (öre) from the same pre-closing trial balance: what R11
  // must equal, up to the öre truncation of R1-R10.
  bookedResult: number
  // Why the SRU file is refused (an account without a ruta, R11 differing
  // from bookedResult, a booked periodiseringsfond or a booked skatt). Empty
  // when it can be filed; each text is also in warnings.
  sruBlockers: string[]
}

// A complete SRU submission: two files (INFO.SRU + BLANKETTER.SRU), ISO 8859-1 encoded by the route.
export interface SRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

