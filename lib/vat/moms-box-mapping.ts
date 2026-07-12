/**
 * Momsdeklaration box mapping for Swedish VAT returns.
 *
 * Maps BAS revenue accounts to the correct box (ruta) in the
 * momsdeklaration filed with Skatteverket. Used by:
 * - Export VAT Monitor (full box overview)
 * - EU Sales List (cross-validation against box 35/39)
 *
 * Reference: Skatteverket momsdeklaration (SKV 4700)
 * https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen
 */

/** Momsdeklaration box number */
export type MomsBox =
  | '05'  // Momspliktig försäljning (taxable sales)
  | '06'  // Momspliktiga uttag (taxable withdrawals)
  | '07'  // Vinstmarginalbeskattning (margin scheme)
  | '08'  // Hyresinkomster frivillig beskattning (rental)
  | '10'  // Utgående moms 25%
  | '11'  // Utgående moms 12%
  | '12'  // Utgående moms 6%
  | '20'  // Inköp varor från EU
  | '21'  // Inköp tjänster från EU
  | '22'  // Inköp tjänster utanför EU
  | '23'  // Inköp varor Sverige omvänd skattskyldighet
  | '24'  // Inköp tjänster Sverige omvänd skattskyldighet
  | '30'  // Utgående moms inköp 25%
  | '31'  // Utgående moms inköp 12%
  | '32'  // Utgående moms inköp 6%
  | '35'  // Varuförsäljning till annat EU-land
  | '36'  // Varuförsäljning utanför EU (export)
  | '37'  // Mellanmans inköp trepartshandel
  | '38'  // Mellanmans försäljning trepartshandel
  | '39'  // Tjänsteförsäljning EU (huvudregeln)
  | '40'  // Övrig försäljning av tjänster utomlands
  | '41'  // Försäljning omvänd skattskyldighet Sverige
  | '42'  // Övrig försäljning m.m.
  | '48'  // Ingående moms att dra av
  | '49'  // Moms att betala eller få tillbaka
  | '50'  // Importbeskattningsunderlag
  | '60'  // Importmoms 25%
  | '61'  // Importmoms 12%
  | '62'  // Importmoms 6%

/**
 * Map BAS account to momsdeklaration box.
 *
 * Source of truth for "which moms box does this BAS account contribute to?"
 * Used for cross-validation (Export VAT Monitor, EU Sales List) and any
 * UI that needs to label a journal line by its declaration ruta.
 *
 * Must stay aligned with `ACCOUNT_RUTA` in `lib/reports/vat-declaration.ts`:
 * a regression test asserts that every account mapped here points at the
 * matching ruta and vice versa.
 */
export const ACCOUNT_TO_BOX: Record<string, MomsBox> = {
  // Domestic revenue (taxable) → Box 05
  '3001': '05',  // Försäljning varor/tjänster 25%
  '3002': '05',  // Försäljning varor/tjänster 12%
  '3003': '05',  // Försäljning varor/tjänster 6%

  // Momspliktiga uttag → Box 06
  '3401': '06',
  '3402': '06',
  '3403': '06',

  // EU goods (reverse charge, VAT-free) → Box 35
  '3108': '35',  // Försäljning varor till annat EU-land
  '3521': '35',  // Fakturerade frakter EU (follows goods treatment)

  // Non-EU goods export (zero-rated) → Box 36
  '3105': '36',  // Försäljning varor export utanför EU
  '3522': '36',  // Fakturerade frakter export

  // Triangular trade → Box 38
  '3109': '38',  // Mellanmans försäljning trepartshandel

  // EU services (reverse charge, main rule) → Box 39
  '3308': '39',  // Försäljning tjänster EU

  // Non-EU services → Box 40
  '3305': '40',  // Försäljning tjänster export utanför EU

  // VAT-exempt sales → Box 42
  '3004': '42',  // Momsfri försäljning (AB)
  '3100': '42',  // Momsfria intäkter (EF)
  '3404': '42',  // Momsfria uttag
  '3980': '42',  // Erhållna offentliga stöd m.m.
  '3994': '42',  // Övriga rörelseintäkter momsfria

  // Output VAT 25% → Box 10
  '2610': '10',  // Utgående moms 25% (summary/parent)
  '2611': '10',  // Försäljning inom Sverige
  '2612': '10',  // Egna uttag
  '2613': '10',  // Uthyrning (frivillig skattskyldighet)
  '2616': '10',  // Vinstmarginalbeskattning
  '2618': '10',  // Vilande utgående moms 25%
  // Output VAT 12% → Box 11
  '2620': '11',  // Utgående moms 12% (summary/parent)
  '2621': '11',
  '2622': '11',  // Egna uttag
  '2623': '11',  // Uthyrning
  '2626': '11',  // VMB
  '2628': '11',  // Vilande utgående moms 12%
  // Output VAT 6% → Box 12
  '2630': '12',  // Utgående moms 6% (summary/parent)
  '2631': '12',
  '2632': '12',  // Egna uttag
  '2633': '12',  // Uthyrning
  '2636': '12',  // VMB
  '2638': '12',  // Vilande utgående moms 6%

  // Reverse charge output VAT → Boxes 30, 31, 32
  '2614': '30',
  '2624': '31',
  '2634': '32',

  // Import VAT (since 2015, via momsdeklaration) → Boxes 60, 61, 62
  '2615': '60',  // Import 25%
  '2625': '61',  // Import 12%
  '2635': '62',  // Import 6%

  // Input VAT → Box 48
  '2640': '48',  // Ingående moms (summary/parent)
  '2641': '48',  // Debiterad ingående moms
  '2642': '48',  // Frivillig skattskyldighet
  '2645': '48',  // Beräknad ingående moms (EU/non-EU förvärv)
  '2646': '48',  // Uthyrning
  '2647': '48',  // Omvänd skattskyldighet i Sverige
  '2649': '48',  // Blandad verksamhet

  // Reverse-charge purchase bases (debit on cost accounts) → Boxes 20-24
  '4515': '20',  // Inköp varor EU 25%
  '4516': '20',  // Inköp varor EU 12%
  '4517': '20',  // Inköp varor EU 6%
  '4535': '21',  // Inköp tjänster EU 25% (huvudregeln)
  '4536': '21',  // Inköp tjänster EU 12%
  '4537': '21',  // Inköp tjänster EU 6%
  '4531': '22',  // Inköp tjänster utanför EU 25%
  '4532': '22',  // Inköp tjänster utanför EU 12%
  '4533': '22',  // Inköp tjänster utanför EU 6%
  '4415': '23',  // Inköp varor SE omvänd skattskyldighet 25%
  '4416': '23',  // Inköp varor SE omvänd skattskyldighet 12%
  '4417': '23',  // Inköp varor SE omvänd skattskyldighet 6%
  '4425': '24',  // Inköp tjänster SE omvänd skattskyldighet 25%
  '4426': '24',  // Inköp tjänster SE omvänd skattskyldighet 12%
  '4427': '24',  // Inköp tjänster SE omvänd skattskyldighet 6%

  // Import beskattningsunderlag → Box 50
  '4545': '50',  // Import 25%
  '4546': '50',  // Import 12%
  '4547': '50',  // Import 6%
}

/** Swedish labels for each momsdeklaration box */
export const BOX_LABELS: Record<MomsBox, string> = {
  '05': 'Momspliktig försäljning',
  '06': 'Momspliktiga uttag',
  '07': 'Vinstmarginalbeskattning',
  '08': 'Hyresinkomster (frivillig beskattning)',
  '10': 'Utgående moms 25%',
  '11': 'Utgående moms 12%',
  '12': 'Utgående moms 6%',
  '20': 'Inköp varor från EU',
  '21': 'Inköp tjänster från EU',
  '22': 'Inköp tjänster utanför EU',
  '23': 'Inköp varor Sverige (omvänd skattskyldighet)',
  '24': 'Inköp tjänster Sverige (omvänd skattskyldighet)',
  '30': 'Utgående moms på inköp 25%',
  '31': 'Utgående moms på inköp 12%',
  '32': 'Utgående moms på inköp 6%',
  '35': 'Varuförsäljning till annat EU-land',
  '36': 'Varuförsäljning utanför EU (export)',
  '37': 'Mellanmans inköp vid trepartshandel',
  '38': 'Mellanmans försäljning vid trepartshandel',
  '39': 'Tjänsteförsäljning till EU (huvudregeln)',
  '40': 'Övrig försäljning av tjänster utomlands',
  '41': 'Försäljning med omvänd skattskyldighet (Sverige)',
  '42': 'Övrig försäljning m.m.',
  '48': 'Ingående moms att dra av',
  '49': 'Moms att betala eller få tillbaka',
  '50': 'Beskattningsunderlag vid import',
  '60': 'Importmoms 25%',
  '61': 'Importmoms 12%',
  '62': 'Importmoms 6%',
}

/** Get the momsdeklaration box for a BAS account number */
export function getBoxForAccount(accountNumber: string): MomsBox | undefined {
  return ACCOUNT_TO_BOX[accountNumber]
}

/** Get the Swedish label for a momsdeklaration box */
export function getBoxLabel(box: MomsBox): string {
  return BOX_LABELS[box]
}

/** Boxes that represent VAT-exempt export/EU sales (no output VAT) */
export const EXPORT_BOXES: MomsBox[] = ['35', '36', '38', '39', '40']

/** Boxes that represent taxable domestic sales (have output VAT) */
export const DOMESTIC_BOXES: MomsBox[] = ['05', '06', '07', '08']

/** Boxes that represent output VAT */
export const OUTPUT_VAT_BOXES: MomsBox[] = ['10', '11', '12']

/** Boxes that represent input VAT */
export const INPUT_VAT_BOXES: MomsBox[] = ['48']
