/**
 * BAS class and group labels. Split from bas-reference.ts, whose index
 * helpers import the full ~1,276-account chart (a 315 KB chunk): client
 * components that only need a label must not pay for the data.
 */

/** Swedish labels for each BAS account class (1-8) */
export const ACCOUNT_CLASS_LABELS: Record<number, string> = {
  1: 'Tillgångar',
  2: 'Eget kapital och skulder',
  3: 'Rörelseintäkter',
  4: 'Varuinköp och material',
  5: 'Övriga externa kostnader',
  6: 'Övriga externa kostnader',
  7: 'Personalkostnader och avskrivningar',
  8: 'Finansiella poster och resultat',
}

/** Swedish labels for BAS account groups (first two digits) */
export const ACCOUNT_GROUP_LABELS: Record<string, string> = {
  // Class 1 - Assets
  '10': 'Immateriella anläggningstillgångar',
  '11': 'Byggnader och mark',
  '12': 'Maskiner respektive inventarier',
  '13': 'Finansiella anläggningstillgångar',
  '14': 'Lager, produkter i arbete och pågående arbeten',
  '15': 'Kundfordringar',
  '16': 'Övriga kortfristiga fordringar',
  '17': 'Förutbetalda kostnader och upplupna intäkter',
  '18': 'Kortfristiga placeringar',
  '19': 'Kassa och bank',

  // Class 2 - Equity & Liabilities
  '20': 'Eget kapital',
  '21': 'Obeskattade reserver',
  '22': 'Avsättningar',
  '23': 'Långfristiga skulder',
  '24': 'Kortfristiga skulder till kreditinstitut, kunder och leverantörer',
  '25': 'Skatteskulder',
  '26': 'Moms och punktskatter',
  '27': 'Personalens skatter, avgifter och löneavdrag',
  '28': 'Övriga kortfristiga skulder',
  '29': 'Upplupna kostnader och förutbetalda intäkter',

  // Class 3 - Revenue
  '30': 'Huvudintäkter',
  '31': 'Försäljning av varor utanför Sverige',
  '32': 'Försäljning VMB och omvänd moms',
  '33': 'Försäljning av tjänster utanför Sverige',
  '34': 'Försäljning, egna uttag',
  '35': 'Fakturerade kostnader',
  '36': 'Rörelsens sidointäkter',
  '37': 'Intäktskorrigeringar',
  '38': 'Aktiverat arbete för egen räkning',
  '39': 'Övriga rörelseintäkter',

  // Class 4 - Cost of goods
  '40': 'Inköp av handelsvaror',
  '41': 'Inköp av varor och material',
  '42': 'Sålda handelsvaror VMB',
  '43': 'Inköp av råvaror och material i Sverige',
  '44': 'Inköp av råvaror m.m., omvänd betalningsskyldighet',
  '45': 'Inköp av råvaror m.m. från utlandet',
  '46': 'Inköp av tjänster, underentreprenader och legoarbeten',
  '47': 'Reduktion av inköpspriser',
  '48': 'Andra produktionskostnader',
  '49': 'Förändring av lager, produkter i arbete och pågående arbeten',

  // Class 5 - External expenses
  '50': 'Lokalkostnader',
  '51': 'Fastighetskostnader',
  '52': 'Hyra av anläggningstillgångar',
  '53': 'Energikostnader för drift',
  '54': 'Förbrukningsinventarier och förbrukningsmaterial',
  '55': 'Reparation och underhåll',
  '56': 'Kostnader för transportmedel',
  '57': 'Frakter och transporter',
  '58': 'Resekostnader',
  '59': 'Reklam och PR',

  // Class 6 - Other external expenses
  '60': 'Övriga försäljningskostnader',
  '61': 'Kontorsmateriel och trycksaker',
  '62': 'Tele, data och post',
  '63': 'Företagsförsäkringar och övriga riskkostnader',
  '64': 'Förvaltningskostnader',
  '65': 'Övriga externa tjänster',
  '66': 'Franchisingavgifter',
  '67': 'Särskilt för ideella föreningar och stiftelser',
  '68': 'Inhyrd personal',
  '69': 'Övriga externa kostnader',

  // Class 7 - Personnel
  '70': 'Löner till kollektivanställda',
  '71': 'Löner till anställda',
  '72': 'Löner till tjänstemän och företagsledare',
  '73': 'Kostnadsersättningar och förmåner',
  '74': 'Pensionskostnader',
  '75': 'Sociala och andra avgifter enligt lag och avtal',
  '76': 'Övriga personalkostnader',
  '77': 'Nedskrivningar och återföring av nedskrivningar',
  '78': 'Avskrivningar enligt plan',
  '79': 'Övriga rörelsekostnader',

  // Class 8 - Financial
  '80': 'Resultat från andelar i koncernföretag',
  '81': 'Resultat från andelar i intresseföretag',
  '82': 'Resultat från övriga värdepapper och långfristiga fordringar',
  '83': 'Övriga ränteintäkter och liknande resultatposter',
  '84': 'Räntekostnader och liknande resultatposter',
  '85': 'Extraordinära intäkter',
  '86': 'Extraordinära kostnader',
  '87': 'Bokslutsdispositioner (intäkter)',
  '88': 'Bokslutsdispositioner',
  '89': 'Skatter och årets resultat',
}
