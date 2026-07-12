import { findColumn } from '../shared/column-utils'
import type { DetectedArticleColumns } from './types'

// Keyword lists cover the export headers of Fortnox, Visma and Bokio so files
// from those systems auto-map. Header-only matching (register imports always
// have a header row).

const NAME_KEYWORDS = [
  'benämning', 'benamning', 'artikelnamn', 'artikel namn', 'namn', 'name',
  'produktnamn', 'produkt namn', 'product name', 'article name', 'beskrivning',
  'description', 'title',
]

const NAME_EN_KEYWORDS = [
  'engelska', 'english', 'name en', 'name english', 'name_english',
  'engelskt namn', 'benämning engelska',
]

// Note: bare 'kod'/'code' are deliberately excluded: they collide with
// Fortnox's "Momskod" (a VAT column). EAN is detected first so "EAN-nummer"
// is claimed before the generic 'nummer'/'number' here.
const ARTICLE_NUMBER_KEYWORDS = [
  'artikelnummer', 'artikelnr', 'artnr', 'art nr', 'art no', 'artikelkod',
  'article code', 'sku', 'nummer', 'number',
]

const TYPE_KEYWORDS = ['typ', 'type', 'artikeltyp', 'article type', 'varutyp']

const UNIT_KEYWORDS = ['enhet', 'unit', 'enh', 'uom', 'måttenhet', 'mattenhet']

const VAT_RATE_KEYWORDS = [
  'momssats', 'momskod', 'moms %', 'moms', 'momsprocent', 'vat rate', 'vat code',
  'vat %', 'vat', 'tax rate',
]

const REVENUE_ACCOUNT_KEYWORDS = [
  'försäljningskonto', 'forsaljningskonto', 'intäktskonto', 'intaktskonto',
  'bokföringskonto', 'bokforingskonto', 'sales account', 'revenue account',
  'kontering', 'coding', 'konto', 'account',
]

const COST_PRICE_KEYWORDS = [
  'inköpspris', 'inkopspris', 'självkostnad', 'sjalvkostnad', 'kostpris',
  'kostnadspris', 'purchase price', 'cost price', 'cost',
]

const PRICE_KEYWORDS = [
  'försäljningspris', 'forsaljningspris', 'pris exkl moms', 'pris exkl. moms',
  'à-pris', 'a-pris', 'apris', 'styckpris', 'nettopris', 'net price',
  'unit price', 'pris', 'price', 'belopp', 'sales price',
]

const EAN_KEYWORDS = ['ean', 'ean-kod', 'streckkod', 'gtin', 'barcode']

const HOUSEWORK_KEYWORDS = [
  'rot/rut', 'rot rut', 'arbetstyp', 'husarbete', 'housework', 'rot', 'rut',
]

const NOTES_KEYWORDS = [
  'anteckning', 'anteckningar', 'kommentar', 'kommentarer', 'comment', 'notes',
  'note', 'övrigt', 'ovrigt',
]

/**
 * Detect article-register columns from headers.
 *
 * Detection order matters: more specific columns are claimed first (via the
 * shared `taken` set) so a generic keyword can't swallow them: e.g. EAN before
 * the article number ("EAN-nummer" must not be read as the article number), and
 * the English name before the generic name column.
 */
export function detectArticleColumns(headers: string[]): DetectedArticleColumns {
  const taken = new Set<number>()

  // Order matters (shared `taken` set): claim specific columns before generic
  // ones. EAN before the article number ("EAN-nummer"), the price columns
  // before VAT (so "Pris exkl moms" isn't read as the VAT column), and the
  // generic name column dead last.
  const name_en_col = findColumn(headers, NAME_EN_KEYWORDS, taken)
  const ean_col = findColumn(headers, EAN_KEYWORDS, taken)
  const article_number_col = findColumn(headers, ARTICLE_NUMBER_KEYWORDS, taken)
  const revenue_account_col = findColumn(headers, REVENUE_ACCOUNT_KEYWORDS, taken)
  const cost_price_col = findColumn(headers, COST_PRICE_KEYWORDS, taken)
  const price_col = findColumn(headers, PRICE_KEYWORDS, taken)
  const vat_rate_col = findColumn(headers, VAT_RATE_KEYWORDS, taken)
  const type_col = findColumn(headers, TYPE_KEYWORDS, taken)
  const unit_col = findColumn(headers, UNIT_KEYWORDS, taken)
  const housework_type_col = findColumn(headers, HOUSEWORK_KEYWORDS, taken)
  const notes_col = findColumn(headers, NOTES_KEYWORDS, taken)
  const name_col = findColumn(headers, NAME_KEYWORDS, taken) ?? -1

  // Confidence: name is required; bonus from how many other columns matched.
  let confidence = 0
  if (name_col >= 0) {
    const matched = [
      article_number_col, price_col, vat_rate_col, unit_col,
      revenue_account_col, type_col,
    ].filter((c) => c !== null).length
    confidence = 0.55 + Math.min(matched, 6) * 0.075
  }

  return {
    name_col: name_col >= 0 ? name_col : 0,
    article_number_col,
    name_en_col,
    type_col,
    unit_col,
    price_col,
    vat_rate_col,
    revenue_account_col,
    cost_price_col,
    ean_col,
    housework_type_col,
    notes_col,
    // Confidence is a 0-1 heuristic score (not money), only compared against the
    // 0.8 skip-mapping threshold: no öre rounding needed.
    confidence: Math.min(confidence, 1),
  }
}
