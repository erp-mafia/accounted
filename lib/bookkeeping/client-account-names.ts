/**
 * Client-safe account name map for UI display.
 * Covers the ~30 accounts used in transaction categorization.
 * No server dependencies: safe for 'use client' components.
 */

const ACCOUNT_NAMES: Record<string, string> = {
  // Assets (1xxx)
  '1250': 'Inventarier',
  '1510': 'Kundfordringar',
  '1630': 'Skattekonto',
  '1680': 'Fordringar hos ägare',
  '1930': 'Företagskonto',

  // Equity & Liabilities (2xxx)
  '2013': 'Övriga egna uttag',
  '2018': 'Egna insättningar',
  '2350': 'Långfristiga skulder',
  '2393': 'Kortfristig skuld närstående',
  '2440': 'Leverantörsskulder',
  '2510': 'Personalskatt',
  '2611': 'Utg. moms 25%',
  '2621': 'Utg. moms 12%',
  '2631': 'Utg. moms 6%',
  '2614': 'Utg. moms omvänd 25%',
  '2624': 'Utg. moms omvänd 12%',
  '2634': 'Utg. moms omvänd 6%',
  '2641': 'Ing. moms',
  '2645': 'Beräknad ing. moms förvärv utlandet',
  '2647': 'Beräknad ing. moms omvänd i Sverige',
  '2731': 'Arbetsgivaravgifter',
  '2893': 'Skuld till ägare',

  // Revenue (3xxx)
  '3001': 'Försäljning 25%',
  '3002': 'Försäljning 12%',
  '3003': 'Försäljning 6%',
  '3004': 'Momsfri försäljning',
  '3305': 'Exportförsäljning',
  '3308': 'EU-tjänster',
  '3900': 'Övriga rörelseintäkter',
  '3960': 'Valutakursvinster',

  // Cost of goods (4xxx)
  '4010': 'Varuinköp',
  '4060': 'Varuinköp omvänd moms',
  '4070': 'Varuinköp EU',
  '4100': 'Inköp material/varor',
  '4500': 'Övriga inköpskostnader',
  '4531': 'Import-/tullkostnader',
  '4600': 'Subentreprenader',

  // External expenses (5xxx)
  '5010': 'Lokalhyra',
  '5020': 'El & uppvärmning',
  '5410': 'Förbrukningsinventarier',
  '5420': 'Programvaror',
  '5421': 'Molntjänster',
  '5460': 'Förbrukningsvaror',
  '5611': 'Drivmedel bil',
  '5613': 'Reparation fordon',
  '5614': 'Parkering',
  '5615': 'Leasing fordon',
  '5800': 'Resekostnader',
  '5810': 'Biljetter & transport',
  '5820': 'Hotell',
  '5910': 'Annonsering',
  '5920': 'Design & grafik',
  '5990': 'Konferens',

  // Other external expenses (6xxx)
  '6071': 'Representation',
  '6110': 'Kontorsförbrukning',
  '6200': 'Telefon & internet',
  '6211': 'Mobiltelefon',
  '6230': 'Internet',
  '6250': 'Porto',
  '6310': 'Företagsförsäkring',
  '6530': 'Redovisningstjänster',
  '6550': 'Konsulttjänster',
  '6570': 'Bankavgifter',
  '6980': 'Medlemsavgifter',
  '6991': 'Övriga kostnader',

  // Personnel & financial (7xxx / 8xxx)
  '7210': 'Löner',
  '7410': 'Pensionsförsäkring',
  '7610': 'Utbildning',
  '7622': 'Intern representation',
  '7960': 'Valutakursförluster',
  '8310': 'Ränteintäkter',
  '8410': 'Räntekostnader',
}

/**
 * Get the Swedish display name for an account number.
 * Returns the number itself if no name is mapped.
 */
export function getAccountName(accountNumber: string): string {
  return ACCOUNT_NAMES[accountNumber] || accountNumber
}

/**
 * Format an account number with its name, e.g. "5010 Lokalhyra".
 */
export function formatAccountWithName(accountNumber: string): string {
  const name = ACCOUNT_NAMES[accountNumber]
  return name ? `${accountNumber} ${name}` : accountNumber
}
