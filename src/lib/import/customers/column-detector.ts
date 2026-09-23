import {
  EXTERNAL_NUMBER_KEYWORDS,
  findColumn,
  findColumnMatch,
} from '../shared/column-utils'
import type { DetectedCustomerColumns } from './types'

const NAME_KEYWORDS = [
  'kundnamn', 'kund namn', 'namn', 'name', 'kund', 'customer', 'customer name',
  'företag', 'foretag', 'company', 'företagsnamn', 'foretagsnamn',
]

const ORG_NUMBER_KEYWORDS = [
  'orgnr', 'org nr', 'orgnummer', 'org nummer', 'organisationsnummer',
  'organisationsnr', 'org', 'personnr', 'personnummer', 'org number',
  'organization number', 'organisation number',
  // Visma and Spiris English exports (#2548)
  'corporate identity number', 'corporate identity no', 'corporate identity',
  'company registration number',
]

const CUSTOMER_TYPE_KEYWORDS = [
  'kundtyp', 'kund typ', 'typ', 'type', 'customer type', 'customer_type',
]

const EMAIL_KEYWORDS = [
  'epost', 'e post', 'email', 'mail', 'e mail', 'e-post',
]

const PHONE_KEYWORDS = [
  'telefon', 'tel', 'phone', 'mobil', 'mobile', 'telefonnummer',
]

const ADDRESS_LINE1_KEYWORDS = [
  'adress', 'address', 'gatuadress', 'street', 'gata',
  'address line 1', 'address1', 'adressrad 1', 'adress 1',
]

// 'co' is two characters, so it only matches as a whole word ("C/O", "CO"):
// as a substring it swallowed "Corporate identity number" and "Country".
const ADDRESS_LINE2_KEYWORDS = [
  'address line 2', 'address2', 'adressrad 2', 'adress 2', 'c o', 'co',
]

const POSTAL_CODE_KEYWORDS = [
  'postnr', 'postnummer', 'postal code', 'postal_code', 'zip', 'zip code',
]

const CITY_KEYWORDS = ['ort', 'stad', 'city', 'postort']

const COUNTRY_KEYWORDS = ['land', 'country']

// 'vat' is three characters, so it only matches as a whole word: as a
// substring it matched the Swedish word "Privat".
const VAT_NUMBER_KEYWORDS = [
  'vat', 'vatnr', 'vat nr', 'vat no', 'vat number', 'momsnummer',
  'momsregistreringsnummer', 'momsregnr', 'momsnr', 'moms nr',
]

const PAYMENT_TERMS_KEYWORDS = [
  'betalningsvillkor', 'betalvillkor', 'payment terms', 'kredittid', 'kreditdagar',
  'dagar', 'förfallodagar', 'forfallodagar',
]

const NOTES_KEYWORDS = [
  'anteckning', 'anteckningar', 'notes', 'kommentar', 'kommentarer', 'comment',
  'note', 'beskrivning',
]

/**
 * Detect customer-register columns from headers.
 * Header-only matching: register imports always have headers, and the column
 * structure varies too much to do data-driven fallbacks reliably.
 */
export function detectCustomerColumns(headers: string[]): DetectedCustomerColumns {
  const taken = new Set<number>()

  // The name column is scored first and rejects record-number headers, so
  // "Customer number" / "Kundnummer" cannot win it over "Customer name".
  const nameMatch = findColumnMatch(headers, NAME_KEYWORDS, taken, {
    reject: EXTERNAL_NUMBER_KEYWORDS,
  })
  const name_col = nameMatch?.index ?? -1
  const org_number_col = findColumn(headers, ORG_NUMBER_KEYWORDS, taken)
  const customer_type_col = findColumn(headers, CUSTOMER_TYPE_KEYWORDS, taken)
  const email_col = findColumn(headers, EMAIL_KEYWORDS, taken)
  const phone_col = findColumn(headers, PHONE_KEYWORDS, taken)
  // Line 2 before line 1: "Address line 2" also contains the whole word
  // "address", so a file that has line 2 but no line 1 would otherwise hand it
  // to line 1.
  const address_line2_col = findColumn(headers, ADDRESS_LINE2_KEYWORDS, taken)
  const address_line1_col = findColumn(headers, ADDRESS_LINE1_KEYWORDS, taken)
  const postal_code_col = findColumn(headers, POSTAL_CODE_KEYWORDS, taken)
  const city_col = findColumn(headers, CITY_KEYWORDS, taken)
  const country_col = findColumn(headers, COUNTRY_KEYWORDS, taken)
  const vat_number_col = findColumn(headers, VAT_NUMBER_KEYWORDS, taken)
  const payment_terms_col = findColumn(headers, PAYMENT_TERMS_KEYWORDS, taken)
  const notes_col = findColumn(headers, NOTES_KEYWORDS, taken)

  // Confidence: name is required; bonus from how many other columns matched.
  let confidence = 0
  if (nameMatch) {
    const matched = [
      org_number_col, email_col, phone_col, address_line1_col,
      postal_code_col, city_col, vat_number_col, payment_terms_col,
    ].filter((c) => c !== null).length
    confidence = 0.55 + Math.min(matched, 6) * 0.075
    // A name column reached only by a loose substring ("Kundregister" via
    // "kund") is a guess: keep it under the 0.8 gate that skips the mapping
    // step, so the user gets to confirm the column.
    if (nameMatch.tier === 'substring') confidence = Math.min(confidence, 0.75)
  }

  return {
    // -1 when no header looked like a name: confidence is then 0, so the
    // mapping step is shown instead of silently importing column 0 as the name.
    name_col,
    org_number_col,
    customer_type_col,
    email_col,
    phone_col,
    address_line1_col,
    address_line2_col,
    postal_code_col,
    city_col,
    country_col,
    vat_number_col,
    payment_terms_col,
    notes_col,
    confidence: Math.min(Math.round(confidence * 100) / 100, 1),
  }
}
