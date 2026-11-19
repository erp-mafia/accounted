/**
 * Whose giro number a bank row shows (crm#1204): read from the bank's own
 * text and the company's own records, never guessed.
 *
 * A bank row that names nobody but a bankgiro number is, in most cases, not
 * a payment from or to that number's holder. It is Bankgirot settling
 * through the company's OWN bankgiro: a deposit ("BG 123-4567 00012",
 * "1234566: Bankgiro inbetalning", "BGGIRERING 12345678") credits the day's
 * incoming payments to the company's bankgiro as one row, and a
 * leverantörsbetalning ("LBE 123-4567") debits the day's supplier payments
 * as one row. The bank prints the company's own number; the payers and
 * payees are listed only in Bankgirot's specification (on Open Payments,
 * the split in bank_transaction_parts). On production (2026-10-15) such
 * aggregates were 3,269 of about 3,650 rows in 90 days whose only
 * counterparty was a giro number, and where the company had its bankgiro on
 * file the printed number was that bankgiro for 141 of 146 company and
 * phrasing pairs over a year. A public registry lookup would only answer
 * with the company's own name for them.
 *
 * The reading, in order:
 *   1. the bank gave a name (a merchant name, or words in its text):
 *      nothing to add;
 *   2. Bankgirot's deposit or leverantörsbetalning phrasing: the company's
 *      own bankgiro, `onFile` when it is the giro in its settings or on a
 *      cash account;
 *   3. a giro number in the row equal to one the company has on file: own;
 *   4. an outgoing row whose counterparty giro (the bank's counterparty
 *      account, or a BG/PG number in the text) is on exactly one supplier
 *      card: that supplier's name;
 *   5. otherwise nothing: a guess is worse than the number.
 *
 * Derived, never stored: the bank's text stays as it came and every surface
 * shows this beside it, saying where it was read from. Pure and
 * client-safe: the transactions page, the MCP transaction list and the
 * supplier-invoice matcher (counterpartyGiroDigits) all read rows here.
 */
import {
  formatBankgiroNumber,
  formatPlusgiroNumber,
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'

export type GiroScheme = 'bankgiro' | 'plusgiro'

/** The bank-row fields the reading looks at. */
export interface GiroRow {
  amount: number
  description?: string | null
  original_description?: string | null
  merchant_name?: string | null
  counterparty_account?: string | null
  reference?: string | null
}

export interface GiroRegister {
  /** The company's own giro numbers (digits, no leading zeros). */
  own: ReadonlyMap<string, GiroScheme>
  /** Supplier giro numbers (digits, no leading zeros) and every distinct supplier name that carries them. */
  suppliers: ReadonlyMap<string, { scheme: GiroScheme; names: readonly string[] }>
}

export type GiroCounterparty =
  | {
      /** Bankgirot through the company's own giro: incoming payments (deposit) or supplier payments (payout), one row for many. */
      kind: 'own_deposit' | 'own_payout'
      scheme: GiroScheme
      /** Formatted, e.g. "123-4566". */
      giro: string
      /** True when the number is the company's own on file; false when only Bankgirot's phrasing says so. */
      onFile: boolean
    }
  | {
      kind: 'supplier'
      scheme: GiroScheme
      giro: string
      /** The one supplier card that carries the number. */
      name: string
    }

export interface GiroRegisterSource {
  own: ReadonlyArray<{ bankgiro?: string | null; plusgiro?: string | null }>
  suppliers: ReadonlyArray<{ name?: string | null; bankgiro?: string | null; plusgiro?: string | null }>
}

/** Digits without leading zeros: banks pad giro numbers to 10 or 13 digits ("BG 0000005786439"). */
export function giroKey(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '').replace(/^0+/, '')
}

export function formatGiro(digits: string, scheme: GiroScheme): string {
  return scheme === 'plusgiro' ? formatPlusgiroNumber(digits) : formatBankgiroNumber(digits)
}

function isValid(digits: string, scheme: GiroScheme): boolean {
  return scheme === 'plusgiro' ? validatePlusgiroNumber(digits) : validateBankgiroNumber(digits)
}

export function buildGiroRegister(source: GiroRegisterSource): GiroRegister {
  const own = new Map<string, GiroScheme>()
  for (const row of source.own) {
    const bg = giroKey(row.bankgiro)
    if (bg) own.set(bg, 'bankgiro')
    const pg = giroKey(row.plusgiro)
    if (pg && !own.has(pg)) own.set(pg, 'plusgiro')
  }
  const suppliers = new Map<string, { scheme: GiroScheme; names: string[] }>()
  const add = (digits: string, scheme: GiroScheme, name: string) => {
    if (!digits || !name || own.has(digits)) return
    const entry = suppliers.get(digits) ?? { scheme, names: [] }
    if (!entry.names.some((n) => n.toLowerCase() === name.toLowerCase())) entry.names.push(name)
    suppliers.set(digits, entry)
  }
  for (const row of source.suppliers) {
    const name = (row.name ?? '').trim()
    add(giroKey(row.bankgiro), 'bankgiro', name)
    add(giroKey(row.plusgiro), 'plusgiro', name)
  }
  return { own, suppliers }
}

// ── The bank's text ─────────────────────────────────────────────────────

/** What the bank wrote: the ingest-time text, not a title the person edited. */
function bankText(row: GiroRow): string {
  return (row.original_description || row.description || '').trim()
}

/**
 * Bankgirot's phrasing for a settlement through the company's own giro, as
 * the Swedish banks print it (observed on production rows). Each captures
 * the giro number.
 */
const OWN_DEPOSIT_PHRASES: readonly RegExp[] = [
  /^BG\s*0*(\d{3,4}-?\d{4})(?:\s+\d+)?$/i, // SEB, Open Payments: "BG 123-4567  00012"
  /^BGGIRERING\s*0*(\d{7,8})(?:\s+\d+)?$/i, // Danske Bank
  /^BI\s+0*(\d{7,8})(?:\s+\d+)?$/i, // Danske Bank
  /^0*(\d{7,8}):?\s*Bankgiro\s*inbetalning$/i, // Swedbank statement file
  /^0*(\d{7,8})\s+BG-IN[SB]\S*$/i, // Länsförsäkringar: "1234567 BG-INSÄTTNING"
]
const OWN_PAYOUT_PHRASES: readonly RegExp[] = [
  /^LB[A-Z]?\s*0*(\d{3,4}-?\d{4})$/i, // SEB leverantörsbetalningar: "LBE 123-4567", "LBS1234-5678"
]
/** Swedbank's feed says only "Bankgiro inbetalning" and sends the number as the reference. */
const BARE_DEPOSIT_PHRASE = /^Bankgiro\s*inbetalning$/i

function ownPhrase(row: GiroRow): { kind: 'own_deposit' | 'own_payout'; digits: string } | null {
  const text = bankText(row)
  if (!text) return null
  const phrases = row.amount > 0 ? OWN_DEPOSIT_PHRASES : row.amount < 0 ? OWN_PAYOUT_PHRASES : []
  for (const re of phrases) {
    const m = re.exec(text)
    if (m) {
      const digits = giroKey(m[1])
      return validateBankgiroNumber(digits) ? { kind: row.amount > 0 ? 'own_deposit' : 'own_payout', digits } : null
    }
  }
  if (row.amount > 0 && BARE_DEPOSIT_PHRASE.test(text) && /^\s*0*\d{7,8}\s*$/.test(row.reference ?? '')) {
    const digits = giroKey(row.reference)
    if (validateBankgiroNumber(digits)) return { kind: 'own_deposit', digits }
  }
  return null
}

// Words a bank prints around a giro number that name nobody.
const GENERIC_WORDS = new Set([
  'bg', 'pg', 'bi', 'lb', 'lbe', 'lbs', 'lbp', 'bankgiro', 'bankgirot', 'plusgiro', 'giro', 'bggirering', 'girering',
  'inbetalning', 'inbetalningar', 'insättning', 'insattning', 'ins', 'inb', 'kontoins', 'betalning', 'bet', 'via',
  'internet', 'ocr', 'bm', 'ref', 'referens', 'nr', 'autogiro',
])

/** True when neither the merchant name nor the bank's text carries a word beyond giro numbers and payment words. */
function namesNobody(row: GiroRow): boolean {
  const words = `${bankText(row)} ${row.merchant_name ?? ''}`.toLowerCase().split(/[^a-zåäöéü]+/)
  return !words.some((w) => w.length >= 2 && !GENERIC_WORDS.has(w))
}

interface Candidate {
  digits: string
  /** Null when the number alone does not say which giro it is. */
  scheme: GiroScheme | null
  /** A bare 7-8 digit number: only trusted when it equals the company's own giro. */
  bare: boolean
}

const PREFIXED_GIRO = /\b(BG|PG)\s*0*(\d{3,4}-\d{4}|\d{1,7}-\d|\d{2,8})(?![\d-])/gi
const HYPHENATED_BG = /(?<![\d-])(\d{3,4}-\d{4})(?![\d-])/g
const BARE_NUMBER = /(?<![\d-])0*(\d{7,8})(?![\d-])/g

function candidates(row: GiroRow): Candidate[] {
  const out: Candidate[] = []
  const push = (c: Candidate) => {
    if (c.digits.length < 2) return
    const valid = c.scheme ? isValid(c.digits, c.scheme) : validateBankgiroNumber(c.digits) || validatePlusgiroNumber(c.digits)
    if (valid && !out.some((o) => o.digits === c.digits && o.bare === c.bare)) out.push(c)
  }
  const account = (row.counterparty_account ?? '').trim()
  if (/^0*\d{3,4}-\d{4}$/.test(account)) push({ digits: giroKey(account), scheme: 'bankgiro', bare: false })
  else if (/^0*\d{1,7}-\d$/.test(account)) push({ digits: giroKey(account), scheme: 'plusgiro', bare: false })
  else if (/^0*\d{5,8}$/.test(account)) push({ digits: giroKey(account), scheme: null, bare: false })

  const text = `${bankText(row)} ${row.merchant_name ?? ''}`
  for (const m of text.matchAll(PREFIXED_GIRO)) {
    push({ digits: giroKey(m[2]), scheme: m[1]!.toUpperCase() === 'PG' ? 'plusgiro' : 'bankgiro', bare: false })
  }
  for (const m of text.matchAll(HYPHENATED_BG)) push({ digits: giroKey(m[1]), scheme: 'bankgiro', bare: false })
  for (const m of text.matchAll(BARE_NUMBER)) push({ digits: giroKey(m[1]), scheme: null, bare: true })
  return out
}

/**
 * The giro numbers that identify the row's counterparty, for matching it to
 * a supplier invoice: the bank's counterparty account and BG/PG numbers in
 * its text. Empty for Bankgirot's settlement through the company's own giro,
 * whose printed number is never the payee's.
 */
export function counterpartyGiroDigits(row: GiroRow): string[] {
  if (ownPhrase(row)) return []
  return [...new Set(candidates(row).filter((c) => !c.bare).map((c) => c.digits))]
}

/** Whether the row can carry a giro reading at all: lets a caller skip loading the register. */
export function mayReadGiro(row: GiroRow): boolean {
  return ownPhrase(row) !== null || (namesNobody(row) && candidates(row).length > 0)
}

/** A tx_inbox_card message: the key and its values. */
export interface GiroMessage {
  key:
    | 'giro_own_deposit'
    | 'giro_own_deposit_likely'
    | 'giro_own_payout'
    | 'giro_own_payout_likely'
    | 'giro_supplier'
    | 'giro_short_own'
    | 'giro_short_own_likely'
  values: Record<string, string>
}

/** The drawer's sentence for a reading: what the giro is, and that the bank row names nobody behind it. */
export function giroSentence(reading: GiroCounterparty): GiroMessage {
  const values = { giro: reading.giro, scheme: reading.scheme }
  if (reading.kind === 'supplier') return { key: 'giro_supplier', values: { ...values, name: reading.name } }
  const base = reading.kind === 'own_deposit' ? 'giro_own_deposit' : 'giro_own_payout'
  return { key: reading.onFile ? base : `${base}_likely`, values }
}

/** The list's short label: the supplier's name, else whose giro it is; a string to show as is, or a message. */
export function giroShortLabel(reading: GiroCounterparty): string | GiroMessage {
  if (reading.kind === 'supplier') return reading.name
  return reading.onFile
    ? { key: 'giro_short_own', values: { scheme: reading.scheme } }
    : { key: 'giro_short_own_likely', values: {} }
}

/**
 * The reading as API and MCP rows carry it (snake case). `on_file: false`
 * means only Bankgirot's phrasing says the giro is the company's own.
 */
export function giroCounterpartyForWire(
  reading: GiroCounterparty,
): { kind: GiroCounterparty['kind']; scheme: GiroScheme; giro: string; on_file?: boolean; name?: string } {
  return reading.kind === 'supplier'
    ? { kind: reading.kind, scheme: reading.scheme, giro: reading.giro, name: reading.name }
    : { kind: reading.kind, scheme: reading.scheme, giro: reading.giro, on_file: reading.onFile }
}

export function readGiroCounterparty(row: GiroRow, register: GiroRegister | null): GiroCounterparty | null {
  if (!namesNobody(row)) return null
  const own = register?.own ?? new Map<string, GiroScheme>()

  const phrase = ownPhrase(row)
  if (phrase) {
    return { kind: phrase.kind, scheme: 'bankgiro', giro: formatGiro(phrase.digits, 'bankgiro'), onFile: own.has(phrase.digits) }
  }
  if (row.amount === 0) return null

  const found = candidates(row)
  const ownHit = found.find((c) => own.has(c.digits))
  if (ownHit) {
    const scheme = own.get(ownHit.digits)!
    return { kind: row.amount > 0 ? 'own_deposit' : 'own_payout', scheme, giro: formatGiro(ownHit.digits, scheme), onFile: true }
  }

  // A deposit's giro is the receiving one: only an outgoing payment names its payee by giro.
  if (row.amount > 0 || !register) return null
  const hits = found
    .filter((c) => !c.bare)
    .map((c) => ({ c, entry: register.suppliers.get(c.digits) }))
    .filter((h): h is { c: Candidate; entry: { scheme: GiroScheme; names: readonly string[] } } => Boolean(h.entry))
  const names = new Set(hits.flatMap((h) => h.entry.names.map((n) => n.toLowerCase())))
  if (hits.length === 0 || names.size !== 1) return null
  const { c, entry } = hits[0]!
  const scheme = c.scheme ?? entry.scheme
  return { kind: 'supplier', scheme, giro: formatGiro(c.digits, scheme), name: entry.names[0]! }
}
