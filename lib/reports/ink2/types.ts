/**
 * INK2R: Räkenskapsschema (balance sheet + income statement)
 * Field codes per Skatteverket spec and bas.se/kontoplaner/sru/
 */
export interface INK2RRutor {
  // Balance sheet - Assets (Tillgångar)
  '7201': number  // 2.1  Koncessioner, patent, licenser, varumärken, hyresrätter, goodwill
  '7202': number  // 2.2  Förskott avs. immateriella anläggningstillgångar
  '7214': number  // 2.3  Byggnader och mark
  '7215': number  // 2.4  Maskiner, inventarier, övriga materiella anläggningstillgångar
  '7216': number  // 2.5  Förbättringsutgifter på annans fastighet
  '7217': number  // 2.6  Pågående nyanläggningar, förskott materiella anläggningstillgångar
  '7230': number  // 2.7  Andelar i koncernföretag
  '7231': number  // 2.8  Andelar i intresseföretag och gemensamt styrda företag
  '7233': number  // 2.9  Ägarintressen i övriga företag + andra långfristiga värdepapper
  '7232': number  // 2.10 Fordringar hos koncern-/intresse-/gemensamt styrda företag
  '7234': number  // 2.11 Lån till delägare eller närstående
  '7235': number  // 2.12 Fordringar hos övriga + andra långfristiga fordringar
  '7241': number  // 2.13 Råvaror och förnödenheter
  '7242': number  // 2.14 Varor under tillverkning
  '7243': number  // 2.15 Färdiga varor och handelsvaror
  '7244': number  // 2.16 Övriga lagertillgångar
  '7245': number  // 2.17 Pågående arbeten för annans räkning
  '7246': number  // 2.18 Förskott till leverantörer
  '7251': number  // 2.19 Kundfordringar
  '7252': number  // 2.20 Fordringar koncern/intresse (kortfristiga)
  '7261': number  // 2.21 Fordringar övriga + övriga fordringar
  '7262': number  // 2.22 Upparbetad men ej fakturerad intäkt
  '7263': number  // 2.23 Förutbetalda kostnader och upplupna intäkter
  '7270': number  // 2.24 Andelar i koncernföretag (kortfristiga)
  '7271': number  // 2.25 Övriga kortfristiga placeringar
  '7281': number  // 2.26 Kassa, bank och redovisningsmedel

  // Balance sheet - Equity & Liabilities (Eget kapital och skulder)
  '7301': number  // 2.27 Bundet eget kapital
  '7302': number  // 2.28 Fritt eget kapital
  '7321': number  // 2.29 Periodiseringsfonder
  '7322': number  // 2.30 Ackumulerade överavskrivningar
  '7323': number  // 2.31 Övriga obeskattade reserver
  '7331': number  // 2.32 Avsättningar för pensioner enl. tryggandelagen
  '7332': number  // 2.33 Övriga avsättningar för pensioner
  '7333': number  // 2.34 Övriga avsättningar
  '7350': number  // 2.35 Obligationslån
  '7351': number  // 2.36 Checkräkningskredit (långfristig)
  '7352': number  // 2.37 Övriga skulder till kreditinstitut (långfristiga)
  '7353': number  // 2.38 Skulder koncern/intresse (långfristiga)
  '7354': number  // 2.39 Övriga skulder (långfristiga)
  '7360': number  // 2.40 Checkräkningskredit (kortfristig)
  '7361': number  // 2.41 Övriga skulder till kreditinstitut (kortfristiga)
  '7362': number  // 2.42 Förskott från kunder
  '7363': number  // 2.43 Pågående arbeten (skuldsida)
  '7364': number  // 2.44 Fakturerad men ej upparbetad intäkt
  '7365': number  // 2.45 Leverantörsskulder
  '7366': number  // 2.46 Växelskulder
  '7367': number  // 2.47 Skulder koncern/intresse (kortfristiga)
  '7369': number  // 2.48 Övriga skulder (kortfristiga)
  '7368': number  // 2.49 Skatteskulder
  '7370': number  // 2.50 Upplupna kostnader och förutbetalda intäkter

  // Income statement (Resultaträkning)
  '7410': number  // 3.1  Nettoomsättning
  '7411': number  // 3.2  Förändring av lager
  '7412': number  // 3.3  Aktiverat arbete för egen räkning
  '7413': number  // 3.4  Övriga rörelseintäkter
  '7511': number  // 3.5  Råvaror och förnödenheter
  '7512': number  // 3.6  Handelsvaror
  '7513': number  // 3.7  Övriga externa kostnader
  '7514': number  // 3.8  Personalkostnader
  '7515': number  // 3.9  Av- och nedskrivningar materiella/immateriella
  '7516': number  // 3.10 Nedskrivningar omsättningstillgångar
  '7517': number  // 3.11 Övriga rörelsekostnader
  '7414': number  // 3.12 Resultat från andelar i koncernföretag
  '7415': number  // 3.13 Resultat från andelar i intresseföretag
  '7423': number  // 3.14 Resultat från övriga företag med ägarintresse
  '7416': number  // 3.15 Resultat från övriga finansiella anläggningstillgångar
  '7417': number  // 3.16 Övriga ränteintäkter och liknande
  '7521': number  // 3.17 Nedskrivningar finansiella anläggningstillgångar
  '7522': number  // 3.18 Räntekostnader och liknande
  '7524': number  // 3.19 Lämnade koncernbidrag
  '7419': number  // 3.20 Mottagna koncernbidrag
  '7420': number  // 3.21 Återföring av periodiseringsfond
  '7525': number  // 3.22 Avsättning till periodiseringsfond
  '7421': number  // 3.23 Förändring av överavskrivningar
  '7422': number  // 3.24 Övriga bokslutsdispositioner
  '7528': number  // 3.25 Skatt på årets resultat
  '7450': number  // 3.26 Årets resultat, vinst (positive)
  '7550': number  // 3.27 Årets resultat, förlust (positive = loss)
}

export type INK2RSRUCode = keyof INK2RRutor

/**
 * INK2: Huvudblankett (main declaration, page 1)
 */
export interface INK2Rutor {
  '7011': string  // Räkenskapsår fr.o.m. (YYYYMMDD)
  '7012': string  // Räkenskapsår t.o.m. (YYYYMMDD)
  '7113': number  // 1.1 Överskott av näringsverksamhet
  '7114': number  // 1.2 Underskott av näringsverksamhet
}

/**
 * INK2S: Skattemässiga justeringar (page 4)
 * Auto-derived fields only. Manual tax adjustments are handled by the accountant.
 */
export interface INK2SRutor {
  '7011': string  // Räkenskapsår fr.o.m. (YYYYMMDD)
  '7012': string  // Räkenskapsår t.o.m. (YYYYMMDD)
  '7650': number  // 4.1  Årets resultat, vinst
  '7750': number  // 4.2  Årets resultat, förlust
  '7651': number  // 4.3a Skatt på årets resultat (ej avdragsgill)
  '8020': number  // 4.15 Överskott → punkt 1.1
  '8021': number  // 4.16 Underskott → punkt 1.2
}

// Account mapping configuration for INK2R
export interface INK2AccountMapping {
  sruCode: INK2RSRUCode
  description: string
  section: 'assets' | 'equity_liabilities' | 'income_statement'
  normalBalance: 'debit' | 'credit' | 'net'
  accountRanges: Array<{
    start: string
    end: string
    exclude?: string[]
  }>
}

// Company info for SRU file generation
export interface INK2CompanyInfo {
  companyName: string
  orgNumber: string | null
  addressLine1: string | null
  postalCode: string | null
  city: string | null
  email: string | null
}

// INK2 declaration response (includes all three blankett sections)
export interface INK2Declaration {
  fiscalYear: {
    id: string
    name: string
    start: string
    end: string
    isClosed: boolean
  }
  ink2: INK2Rutor
  ink2r: INK2RRutor
  ink2s: INK2SRutor
  breakdown: Record<INK2RSRUCode, {
    accounts: Array<{
      accountNumber: string
      accountName: string
      amount: number
    }>
    total: number
  }>
  totals: {
    totalAssets: number
    totalEquityLiabilities: number
    operatingResult: number
    resultAfterFinancial: number
  }
  companyInfo: INK2CompanyInfo
  warnings: string[]
}

// SRU file types: no longer shared with NE-bilaga since the structure
// is fundamentally different (INFO.SRU + BLANKETTER.SRU two-file format)
export interface SRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

// ---- UI display helpers ----

export const INK2R_ASSET_CODES: INK2RSRUCode[] = [
  '7201', '7202', '7214', '7215', '7216', '7217',
  '7230', '7231', '7233', '7232', '7234', '7235',
  '7241', '7242', '7243', '7244', '7245', '7246',
  '7251', '7252', '7261', '7262', '7263',
  '7270', '7271', '7281',
]

export const INK2R_EQUITY_LIABILITY_CODES: INK2RSRUCode[] = [
  '7301', '7302',
  '7321', '7322', '7323',
  '7331', '7332', '7333',
  '7350', '7351', '7352', '7353', '7354',
  '7360', '7361', '7362', '7363', '7364', '7365', '7366', '7367', '7369', '7368',
  '7370',
]

export const INK2R_INCOME_CODES: INK2RSRUCode[] = [
  '7410', '7411', '7412', '7413',
  '7511', '7512', '7513', '7514', '7515', '7516', '7517',
  '7414', '7415', '7423', '7416', '7417',
  '7521', '7522',
  '7524', '7419', '7420', '7525', '7421', '7422',
  '7528',
  '7450', '7550',
]

export const INK2R_RUTA_LABELS: Record<INK2RSRUCode, string> = {
  // Assets
  '7201': 'Koncessioner, patent, licenser, varumärken, goodwill',
  '7202': 'Förskott immateriella anläggningstillgångar',
  '7214': 'Byggnader och mark',
  '7215': 'Maskiner och inventarier',
  '7216': 'Förbättringsutgifter på annans fastighet',
  '7217': 'Pågående nyanläggningar och förskott',
  '7230': 'Andelar i koncernföretag',
  '7231': 'Andelar i intresseföretag',
  '7233': 'Ägarintressen i övriga företag',
  '7232': 'Fordringar koncern-/intresseföretag',
  '7234': 'Lån till delägare eller närstående',
  '7235': 'Övriga långfristiga fordringar',
  '7241': 'Råvaror och förnödenheter',
  '7242': 'Varor under tillverkning',
  '7243': 'Färdiga varor och handelsvaror',
  '7244': 'Övriga lagertillgångar',
  '7245': 'Pågående arbeten för annans räkning',
  '7246': 'Förskott till leverantörer',
  '7251': 'Kundfordringar',
  '7252': 'Fordringar koncern/intresse (kortfristiga)',
  '7261': 'Övriga fordringar',
  '7262': 'Upparbetad men ej fakturerad intäkt',
  '7263': 'Förutbetalda kostnader och upplupna intäkter',
  '7270': 'Andelar i koncernföretag (kortfristiga)',
  '7271': 'Övriga kortfristiga placeringar',
  '7281': 'Kassa, bank och redovisningsmedel',
  // Equity & Liabilities
  '7301': 'Bundet eget kapital',
  '7302': 'Fritt eget kapital',
  '7321': 'Periodiseringsfonder',
  '7322': 'Ackumulerade överavskrivningar',
  '7323': 'Övriga obeskattade reserver',
  '7331': 'Pensionsavsättningar (tryggandelagen)',
  '7332': 'Övriga pensionsavsättningar',
  '7333': 'Övriga avsättningar',
  '7350': 'Obligationslån',
  '7351': 'Checkräkningskredit (långfristig)',
  '7352': 'Övriga skulder kreditinstitut (långfristiga)',
  '7353': 'Skulder koncern/intresse (långfristiga)',
  '7354': 'Övriga skulder (långfristiga)',
  '7360': 'Checkräkningskredit (kortfristig)',
  '7361': 'Övriga skulder kreditinstitut (kortfristiga)',
  '7362': 'Förskott från kunder',
  '7363': 'Pågående arbeten (skuldsida)',
  '7364': 'Fakturerad men ej upparbetad intäkt',
  '7365': 'Leverantörsskulder',
  '7366': 'Växelskulder',
  '7367': 'Skulder koncern/intresse (kortfristiga)',
  '7369': 'Övriga skulder (kortfristiga)',
  '7368': 'Skatteskulder',
  '7370': 'Upplupna kostnader och förutbetalda intäkter',
  // Income statement
  '7410': 'Nettoomsättning',
  '7411': 'Förändring av lager',
  '7412': 'Aktiverat arbete för egen räkning',
  '7413': 'Övriga rörelseintäkter',
  '7511': 'Råvaror och förnödenheter',
  '7512': 'Handelsvaror',
  '7513': 'Övriga externa kostnader',
  '7514': 'Personalkostnader',
  '7515': 'Av- och nedskrivningar',
  '7516': 'Nedskrivningar omsättningstillgångar',
  '7517': 'Övriga rörelsekostnader',
  '7414': 'Resultat andelar koncernföretag',
  '7415': 'Resultat andelar intresseföretag',
  '7423': 'Resultat övriga ägarintresse',
  '7416': 'Övriga finansiella anläggningstillgångar',
  '7417': 'Ränteintäkter',
  '7521': 'Nedskrivningar finansiella anläggningstillgångar',
  '7522': 'Räntekostnader',
  '7524': 'Lämnade koncernbidrag',
  '7419': 'Mottagna koncernbidrag',
  '7420': 'Återföring av periodiseringsfond',
  '7525': 'Avsättning till periodiseringsfond',
  '7421': 'Förändring av överavskrivningar',
  '7422': 'Övriga bokslutsdispositioner',
  '7528': 'Skatt på årets resultat',
  '7450': 'Årets resultat (vinst)',
  '7550': 'Årets resultat (förlust)',
}
