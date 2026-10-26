/**
 * Where the momsdeklaration's Korrigera starts the supplier type of a
 * verifikat whose fiktiv moms lacks its basis (FK004, crm#1431). The person
 * still picks; this only decides the picker's first value.
 *
 * The basis box follows where the seller is (ML 6 kap. 34 §, huvudregeln): a
 * service from another EU country is ruta 21 (4535-4537), from outside the EU
 * ruta 22 (4531-4533). The picker used to start on "EU-leverantör" for every
 * row, so one click put a purchase from a US seller in ruta 21. Each verifikat
 * now starts from the best country signal it has, the first that answers
 * wins:
 *   1. the supplier card behind a supplier-invoice verifikat: its country,
 *      else its VAT number's prefix (sellerCountry), and its supplier type
 *      unless that is the column default swedish_business. A card whose
 *      country and type disagree answers nothing;
 *   2. the counterpart directory (the seed's merchants, matchSeedText) on the
 *      bank row's merchant name and texts, then the verifikat's description.
 *      A brand the booking-template catalog books in the other box than the
 *      directory places it answers nothing: those are the vendors that also
 *      bill from an EU entity, whose box waits on a founder call (crm#1028).
 * Another EU country starts on eu_business, a country outside the EU on
 * non_eu_business. Sweden starts on nothing: omvänd skattskyldighet inom
 * landet covers only the goods and services of ML 16 kap. (bygg, skrot,
 * mobiltelefoner and the like), so fiktiv moms beside a Swedish seller is
 * asked, never assumed. No signal starts on nothing too, and the row cannot
 * be corrected until the person picks.
 *
 * An IBAN is never read: it names the country of the bank that collects the
 * money, which for a foreign seller is often not its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { BOOKING_TEMPLATES } from '@/lib/bookkeeping/booking-templates'
import { matchSeedText } from '@/lib/parties/resolver/directory'
import type { DirectoryEntry } from '@/lib/parties/resolver/directory-seed'
import { chunk } from '@/lib/utils'
import type { RcBasisGap } from '@/lib/reports/rc-basis-gaps'
import { normalizeCountryCode } from './country-codes'
import { regionOfCountry, sellerCountry, supplierTypeForRegion } from './seller-country'

/** A supplier type Korrigera may start on: never the Swedish one (see the file comment). */
export type RcBasisPreselectedSupplierType = 'eu_business' | 'non_eu_business'

export interface RcBasisSupplierDefault {
  supplierType: RcBasisPreselectedSupplierType
  /** ISO 3166-1 alpha-2 the default was read from; null when only the supplier card's type said it. */
  country: string | null
  source: 'supplier_card' | 'directory'
}

/** A worklist row as the gap list route answers it: the scan's row and where its picker starts. */
export type RcBasisGapWithDefault = RcBasisGap & { supplierDefault: RcBasisSupplierDefault | null }

/** The supplier type a seller's country starts Korrigera on, or null for Sweden and an unknown country. */
export function preselectedSupplierTypeForCountry(country: string | null | undefined): RcBasisPreselectedSupplierType | null {
  const code = normalizeCountryCode(country)
  if (!code) return null
  const type = supplierTypeForRegion(regionOfCountry(code))
  return type === 'swedish_business' ? null : type
}

type CardSupplierType = 'eu_business' | 'non_eu_business' | 'swedish_business'

export interface RcBasisSupplierCard {
  country: string | null
  vat_number: string | null
  supplier_type: string | null
}

/** What a supplier card says, by the order in the file comment; null when it says nothing or contradicts itself. */
export function supplierCardDefault(card: RcBasisSupplierCard | null | undefined): RcBasisSupplierDefault | null {
  if (!card) return null
  const country = normalizeCountryCode(card.country) ?? sellerCountry({ vatNumber: card.vat_number }).country
  // swedish_business is what every card gets unless someone chose otherwise: it says nothing.
  const chosenType =
    card.supplier_type === 'eu_business' || card.supplier_type === 'non_eu_business' ? card.supplier_type : null
  if (country) {
    const regionType: CardSupplierType = supplierTypeForRegion(regionOfCountry(country))
    if (chosenType && chosenType !== regionType) return null
    return regionType === 'swedish_business' ? null : { supplierType: regionType, country, source: 'supplier_card' }
  }
  return chosenType ? { supplierType: chosenType, country: null, source: 'supplier_card' } : null
}

/**
 * The supplier types the booking-template catalog books each keyword of a
 * foreign or domestic reverse-charge purchase template in. A leading '=' only
 * says how the keyword matches.
 */
const CATALOG_SUPPLIER_TYPES: ReadonlyMap<string, ReadonlySet<CardSupplierType>> = (() => {
  const byKeyword = new Map<string, Set<CardSupplierType>>()
  for (const template of BOOKING_TEMPLATES) {
    if (template.direction !== 'expense' || template.vat_treatment !== 'reverse_charge') continue
    const type = template.reverse_charge_supplier_type ?? 'eu_business'
    for (const keyword of template.keywords) {
      const key = keyword.replace(/^=/, '').toLowerCase()
      const types = byKeyword.get(key) ?? new Set<CardSupplierType>()
      types.add(type)
      byKeyword.set(key, types)
    }
  }
  return byKeyword
})()

/** Whether the catalog books any of the brand's names as a purchase from a seller of another type. */
function catalogContradicts(entry: DirectoryEntry, type: CardSupplierType): boolean {
  return entry.patterns.some((pattern) => {
    const types = CATALOG_SUPPLIER_TYPES.get(pattern.toLowerCase())
    return !!types && [...types].some((t) => t !== type)
  })
}

/** What the counterpart directory says about the first of the texts that names a merchant it knows. */
export function directorySupplierDefault(texts: ReadonlyArray<string | null | undefined>): RcBasisSupplierDefault | null {
  for (const text of texts) {
    if (!text?.trim()) continue
    const entry = matchSeedText(text)
    // A rail, a bank or an authority is not the seller of the service.
    if (!entry || entry.kind !== 'merchant') continue
    const country = normalizeCountryCode(entry.country)
    if (!country) return null
    const type = supplierTypeForRegion(regionOfCountry(country))
    if (type === 'swedish_business' || catalogContradicts(entry, type)) return null
    return { supplierType: type, country, source: 'directory' }
  }
  return null
}

const ID_CHUNK = 100

const SUPPLIER_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'supplier_invoice_privately_paid',
  'supplier_credit_note',
])

interface EntrySourceRow {
  id: string
  description: string | null
  source_type: string | null
  source_id: string | null
}

interface BankRow {
  id: string
  merchant_name: string | null
  description: string | null
  original_description: string | null
}

interface SupplierInvoiceRow {
  id: string
  supplier: RcBasisSupplierCard | RcBasisSupplierCard[] | null
}

async function readByIds<T>(
  ids: readonly string[],
  read: (slice: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = []
  for (const slice of chunk(ids, ID_CHUNK)) {
    const { data, error } = await read(slice)
    if (error) throw error
    rows.push(...((data as T[] | null) ?? []))
  }
  return rows
}

/**
 * Where Korrigera starts each verifikat's supplier type, by entry id. A
 * verifikat with no default is left out: its picker starts empty.
 */
export async function rcBasisSupplierDefaults(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: readonly string[],
): Promise<Map<string, RcBasisSupplierDefault>> {
  const ids = [...new Set(entryIds)]
  const defaults = new Map<string, RcBasisSupplierDefault>()
  if (ids.length === 0) return defaults

  const entries = await readByIds<EntrySourceRow>(ids, (slice) =>
    supabase
      .from('journal_entries')
      .select('id, description, source_type, source_id')
      .eq('company_id', companyId)
      .in('id', slice),
  )
  const bankIds = entries.filter((e) => e.source_type === 'bank_transaction' && e.source_id).map((e) => e.source_id!)
  const invoiceIds = entries
    .filter((e) => e.source_type && SUPPLIER_SOURCE_TYPES.has(e.source_type) && e.source_id)
    .map((e) => e.source_id!)

  const bankRows = await readByIds<BankRow>([...new Set(bankIds)], (slice) =>
    supabase
      .from('transactions')
      .select('id, merchant_name, description, original_description')
      .eq('company_id', companyId)
      .in('id', slice),
  )
  const invoiceRows = await readByIds<SupplierInvoiceRow>([...new Set(invoiceIds)], (slice) =>
    supabase
      .from('supplier_invoices')
      .select('id, supplier:suppliers(country, vat_number, supplier_type)')
      .eq('company_id', companyId)
      .in('id', slice),
  )
  const bankById = new Map(bankRows.map((row) => [row.id, row]))
  const cardByInvoice = new Map(
    invoiceRows.map((row) => [row.id, Array.isArray(row.supplier) ? (row.supplier[0] ?? null) : row.supplier]),
  )

  for (const entry of entries) {
    const card = entry.source_type && SUPPLIER_SOURCE_TYPES.has(entry.source_type) && entry.source_id
      ? cardByInvoice.get(entry.source_id)
      : null
    const bank = entry.source_type === 'bank_transaction' && entry.source_id ? bankById.get(entry.source_id) : undefined
    const found =
      supplierCardDefault(card) ??
      directorySupplierDefault([bank?.merchant_name, bank?.description, bank?.original_description, entry.description])
    if (found) defaults.set(entry.id, found)
  }
  return defaults
}
