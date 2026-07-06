import { getBASReference, ACCOUNT_CLASS_LABELS } from './bas-reference'

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'untaxed_reserves'

export interface AccountDescription {
  name: string
  classLabel: string
  type: AccountType
  explanation: string
}

const ACCOUNT_DESCRIPTIONS: Record<string, AccountDescription> = {
  // Class 1: Assets (Tillgångar)
  '1510': {
    name: 'Kundfordringar',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Pengar som kunder är skyldiga dig för skickade fakturor som inte betalats ännu.',
  },
  '1580': {
    name: 'Fordran för skatt',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Pengar du har att fordra från Skatteverket, t.ex. överskjutande moms.',
  },
  '1630': {
    name: 'Skattekonto',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Ditt skattekonto hos Skatteverket, visar saldo för inbetalda skatter och avgifter.',
  },
  '1710': {
    name: 'Förutbetalda hyreskostnader',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Hyra som betalats i förskott men som avser kommande perioder.',
  },
  '1910': {
    name: 'Kassa',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Kontanta pengar i företagets kassa.',
  },
  '1920': {
    name: 'PlusGiro',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Pengar på företagets PlusGiro-konto.',
  },
  '1930': {
    name: 'Företagskonto',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Företagets huvudsakliga bankkonto. Hit kommer inbetalningar och härifrån görs utbetalningar.',
  },
  '1940': {
    name: 'Övriga bankkonton',
    classLabel: 'Tillgångar',
    type: 'asset',
    explanation: 'Ytterligare bankkonton utöver huvudkontot.',
  },

  // Class 2: Equity & Liabilities (Eget kapital och skulder)
  '2010': {
    name: 'Eget kapital',
    classLabel: 'Eget kapital och skulder',
    type: 'equity',
    explanation: 'Ägarens insatta kapital i enskild firma. Visar vad ägaren har investerat i verksamheten.',
  },
  '2013': {
    name: 'Egna uttag',
    classLabel: 'Eget kapital och skulder',
    type: 'equity',
    explanation: 'Pengar som ägaren av en enskild firma tar ut privat ur företaget.',
  },
  '2018': {
    name: 'Egna insättningar',
    classLabel: 'Eget kapital och skulder',
    type: 'equity',
    explanation: 'Pengar som ägaren sätter in privat i företaget (enskild firma).',
  },
  '2081': {
    name: 'Aktiekapital',
    classLabel: 'Eget kapital och skulder',
    type: 'equity',
    explanation: 'Det registrerade aktiekapitalet i ett aktiebolag.',
  },
  '2091': {
    name: 'Balanserat resultat',
    classLabel: 'Eget kapital och skulder',
    type: 'equity',
    explanation: 'Ackumulerade vinster/förluster från tidigare år som inte delats ut.',
  },
  '2099': {
    name: 'Årets resultat',
    classLabel: 'Eget kapital och skulder',
    type: 'equity',
    explanation: 'Vinst eller förlust för innevarande räkenskapsår.',
  },
  '2440': {
    name: 'Leverantörsskulder',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Pengar du är skyldig leverantörer för mottagna fakturor som inte betalats ännu.',
  },
  '2510': {
    name: 'Skatteskulder',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Skulder till Skatteverket för preliminär skatt och andra skattebetalningar.',
  },
  '2611': {
    name: 'Utgående moms 25%',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Moms du tar ut på försäljning med 25% momssats. Ska betalas in till Skatteverket.',
  },
  '2614': {
    name: 'Utgående moms omvänd skattskyldighet',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Utgående moms vid omvänd skattskyldighet (reverse charge). Köparen redovisar momsen.',
  },
  '2621': {
    name: 'Utgående moms 12%',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Moms du tar ut på försäljning med 12% momssats (t.ex. livsmedel, hotell).',
  },
  '2631': {
    name: 'Utgående moms 6%',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Moms du tar ut på försäljning med 6% momssats (t.ex. böcker, kollektivtrafik).',
  },
  '2641': {
    name: 'Ingående moms',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Moms du betalat på inköp som du har rätt att dra av. Minskar din momsskuld.',
  },
  '2645': {
    name: 'Beräknad ingående moms på EU-förvärv',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Ingående moms du beräknar själv vid inköp från andra EU-länder (omvänd skattskyldighet).',
  },
  '2893': {
    name: 'Lån från aktieägare',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Pengar som aktiebolaget lånat av sina ägare. Vanligt i mindre AB.',
  },
  '2898': {
    name: 'Outtagen vinstutdelning',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Beslutad men ännu ej utbetald aktieutdelning.',
  },
  '2920': {
    name: 'Upplupna semesterlöner',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Skuld för intjänade men ej uttagna semesterdagar.',
  },
  '2940': {
    name: 'Upplupna arbetsgivaravgifter',
    classLabel: 'Eget kapital och skulder',
    type: 'liability',
    explanation: 'Arbetsgivaravgifter som hänför sig till redovisade löner men ännu inte betalats.',
  },

  // Class 3: Revenue (Intäkter)
  '3001': {
    name: 'Försäljning varor/tjänster 25%',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Intäkter från försäljning med 25% moms: den vanligaste intäktsraden.',
  },
  '3002': {
    name: 'Försäljning varor/tjänster 12%',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Intäkter från försäljning med 12% moms (t.ex. livsmedel).',
  },
  '3003': {
    name: 'Försäljning varor/tjänster 6%',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Intäkter från försäljning med 6% moms (t.ex. böcker, tidningar).',
  },
  '3305': {
    name: 'Försäljning export utanför EU',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Intäkter från försäljning till kunder utanför EU. Momsfritt.',
  },
  '3308': {
    name: 'Försäljning tjänster EU',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Intäkter från försäljning av tjänster till företag i andra EU-länder. Omvänd skattskyldighet.',
  },
  '3900': {
    name: 'Övriga rörelseintäkter',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Andra intäkter som inte hör till kärnverksamheten, t.ex. uthyrning av lokaler.',
  },
  '3960': {
    name: 'Valutakursvinster',
    classLabel: 'Intäkter',
    type: 'revenue',
    explanation: 'Vinster som uppstår vid valutaväxling eller betalningar i utländsk valuta.',
  },

  // Class 4: Cost of goods (Varor och material)
  '4010': {
    name: 'Varuinköp',
    classLabel: 'Varor och material',
    type: 'expense',
    explanation: 'Kostnader för inköp av varor som säljs vidare.',
  },

  // Class 5: External expenses (Övriga externa kostnader)
  '5010': {
    name: 'Lokalkostnader',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Kostnader för kontorslokal, lager eller annan arbetsplats (hyra, el, städning).',
  },
  '5410': {
    name: 'Förbrukningsinventarier',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Inköp av mindre inventarier, t.ex. kontorsmöbler, dator (under halva prisbasbeloppet).',
  },
  '5420': {
    name: 'Programvaror',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Kostnader för mjukvara, prenumerationer och licenser.',
  },
  '5800': {
    name: 'Resekostnader',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Tjänsteresor: tåg, flyg, hotell, taxi.',
  },
  '5910': {
    name: 'Annonsering och reklam',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Kostnader för marknadsföring, annonser och reklamkampanjer.',
  },

  // Class 6: Other external expenses
  '6530': {
    name: 'Redovisningstjänster',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Avgifter till bokföringsbyrå eller redovisningskonsult.',
  },
  '6570': {
    name: 'Bankkostnader',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Avgifter för banktjänster, betalförmedling och transaktionsavgifter.',
  },
  '6991': {
    name: 'Övriga externa kostnader',
    classLabel: 'Övriga externa kostnader',
    type: 'expense',
    explanation: 'Diverse externa kostnader som inte passar in under andra konton.',
  },

  // Class 7: Personnel & depreciation
  '7010': {
    name: 'Löner tjänstemän',
    classLabel: 'Personal och avskrivningar',
    type: 'expense',
    explanation: 'Bruttolöner (före skatt) till anställda tjänstemän.',
  },
  '7210': {
    name: 'Löner kollektiv',
    classLabel: 'Personal och avskrivningar',
    type: 'expense',
    explanation: 'Bruttolöner till arbetare och kollektivanställda.',
  },
  '7510': {
    name: 'Arbetsgivaravgifter',
    classLabel: 'Personal och avskrivningar',
    type: 'expense',
    explanation: 'Lagstadgade sociala avgifter som arbetsgivaren betalar (ca 31% av bruttolönen).',
  },
  '7820': {
    name: 'Avskrivningar inventarier',
    classLabel: 'Personal och avskrivningar',
    type: 'expense',
    explanation: 'Årlig värdeminskning på inventarier och maskiner. Fördelas över tillgångens livslängd.',
  },
  '7960': {
    name: 'Valutakursförluster',
    classLabel: 'Personal och avskrivningar',
    type: 'expense',
    explanation: 'Förluster som uppstår vid valutaväxling eller betalningar i utländsk valuta.',
  },

  // Class 8: Financial items
  '8310': {
    name: 'Ränteintäkter',
    classLabel: 'Finansiella poster',
    type: 'revenue',
    explanation: 'Ränta du får på bankkontosaldo eller utlånade pengar.',
  },
  '8410': {
    name: 'Räntekostnader',
    classLabel: 'Finansiella poster',
    type: 'expense',
    explanation: 'Ränta du betalar på lån och krediter.',
  },
  '8999': {
    name: 'Årets resultat',
    classLabel: 'Finansiella poster',
    type: 'equity',
    explanation: 'Slutresultatkonto som visar vinst eller förlust efter alla intäkter och kostnader.',
  },
}

export function getAccountDescription(accountNumber: string): AccountDescription | undefined {
  // Check hardcoded descriptions first (most detailed explanations)
  const hardcoded = ACCOUNT_DESCRIPTIONS[accountNumber]
  if (hardcoded) return hardcoded

  // Fall back to BAS reference data for accounts not in the hardcoded list
  try {
    const ref = getBASReference(accountNumber)
    if (ref) {
      const classLabel = ACCOUNT_CLASS_LABELS[ref.account_class] || ''
      return {
        name: ref.account_name,
        classLabel,
        type: ref.account_type,
        explanation: ref.description,
      }
    }
  } catch {
    // BAS reference not available: that's fine
  }

  return undefined
}

/**
 * Get a human-readable account class name for BAS account classes.
 */
export function getAccountClassName(accountClass: number): string {
  switch (accountClass) {
    case 1:
      return '1xxx - Tillgångar'
    case 2:
      return '2xxx - Eget kapital & Skulder'
    case 3:
      return '3xxx - Intäkter'
    case 4:
      return '4xxx - Varuinköp'
    case 5:
      return '5xxx - Externa kostnader'
    case 6:
      return '6xxx - Övriga externa kostnader'
    case 7:
      return '7xxx - Personal'
    case 8:
      return '8xxx - Finansiella poster'
    default:
      return `${accountClass}xxx - Övrigt`
  }
}

export { ACCOUNT_DESCRIPTIONS }
