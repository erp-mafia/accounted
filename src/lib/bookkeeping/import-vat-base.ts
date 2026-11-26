/**
 * Importmoms is booked with its beskattningsunderlag (#83).
 *
 * Import VAT on goods is self-assessed in the momsdeklaration: the
 * beskattningsunderlag in ruta 50 (BAS 4545/4546/4547) and the utgående moms
 * in rutor 60-62 (BAS 2615/2625/2635). Skatteverket refuses a declaration
 * with one and not the other (kontroll FK005/FK006, Tjänstebeskrivning API
 * Momsdeklaration, 4.1.1.5).
 *
 * The bank-row and inbox doors book the lines a person sends, often expanded
 * from a company's own bokföringsmall (applyTemplate). A mall that puts its
 * fiktiv moms on 2615 beside a cost account outside ruta 50 books importmoms
 * with no base, and in production most such malls are reverse-charge
 * purchases on the pre-2015 account: an EU purchase on 4515, services from
 * outside the EU on 4531 or 6540, whose utgående moms belongs on
 * 2614/2624/2634 (ruta 30-32). The verifikat then feeds ruta 60 without ruta
 * 50 and ruta 20-22 without ruta 30. Adding a base line would be wrong for
 * those, so the doors refuse the shape instead and say what to change.
 *
 * Read with the company's own momsruta per account (the declaration's
 * resolution, vatRutaContributions): a 2615 a company routed to another ruta
 * (vat_box, a chart from a system that used 2615 for reverse charge) is no
 * importmoms here, and an account with momskod import_goods is a base.
 *
 * The rättelse doors judge the verifikat a correction leaves (#94): the
 * corrected lines of a storno + rättelse (correctEntry) and the kept plus the
 * added lines of an inline rättelse (strikeJournalEntryLines), never the
 * replacement lines alone. A rättelse that takes importmoms out passes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatDeclarationRutor } from '@/types'
import { ACCOUNT_RUTA, isMomsAccount } from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts, type DynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import { createLogger } from '@/lib/logger'
import { IMPORT_VAT_WITHOUT_BASE, ImportVatWithoutBaseError } from './errors'

const log = createLogger('bookkeeping/import-vat-base')

export const IMPORT_VAT_WITHOUT_BASE_CODE = IMPORT_VAT_WITHOUT_BASE

const IMPORT_VAT_RUTOR: ReadonlySet<keyof VatDeclarationRutor> = new Set(['ruta60', 'ruta61', 'ruta62'])

/** One line of a verifikat as a door holds it; the amounts may be strings from a form. */
export interface ImportVatShapeLine {
  account_number: string
  debit_amount?: number | string | null
  credit_amount?: number | string | null
}

/** The ruta an account reports to for this company, or null for none. */
export type AccountRuta = (accountNumber: string) => keyof VatDeclarationRutor | null

/**
 * The company's momsruta per account, as the declaration resolves it: the
 * company's own classification first (momsruta on a 26xx account, momskod on
 * a class 3-6 account), the fixed BAS map for every account it did not
 * classify. Mirrors vatRutaContributions (lib/reports/vat-declaration.ts).
 */
export function accountRutaFor(
  dynamic: Pick<DynamicVatAccounts, 'mappingByAccount' | 'explicitAccounts'>,
): AccountRuta {
  return (account) => {
    const own = dynamic.mappingByAccount.get(account)
    if (own) return own.box
    if (dynamic.explicitAccounts.has(account)) return null
    return ACCOUNT_RUTA[account]?.box ?? null
  }
}

function credited(line: ImportVatShapeLine): boolean {
  return (Number(line.credit_amount) || 0) > 0
}

/**
 * The importmoms accounts the lines credit (rutor 60-62) while no line of the
 * same verifikat reaches ruta 50; null when the shape is right. A debit on
 * 2615 (the importmoms of a credited import) is not checked: it is the
 * reversal side, and the declaration's FK006 presence check still reads it.
 */
export function importVatWithoutBase(
  lines: readonly ImportVatShapeLine[],
  rutaOf: AccountRuta,
): string[] | null {
  const importVat = lines
    .filter((line) => credited(line) && IMPORT_VAT_RUTOR.has(rutaOf(line.account_number) as keyof VatDeclarationRutor))
    .map((line) => line.account_number)
  if (importVat.length === 0) return null
  if (lines.some((line) => rutaOf(line.account_number) === 'ruta50')) return null
  return [...new Set(importVat)].sort()
}

/**
 * Whether the lines can carry importmoms at all, before the company's chart is
 * read: a credit on a BAS importmoms account (2615/2625/2635), or on a 26xx
 * number BAS does not know, which a company may have routed to ruta 60-62
 * itself (a Fortnox chart's 2617, say). Every other booking skips the read.
 */
function mayCarryImportVat(lines: readonly ImportVatShapeLine[]): boolean {
  return lines.some((line) => {
    if (!credited(line) || !isMomsAccount(line.account_number)) return false
    const bas = ACCOUNT_RUTA[line.account_number]?.box
    return bas === undefined || IMPORT_VAT_RUTOR.has(bas)
  })
}

export interface ImportVatWithoutBaseRefusal {
  code: typeof IMPORT_VAT_WITHOUT_BASE_CODE
  details: { import_vat_accounts: string[] }
  messageSv: string
  messageEn: string
}

/**
 * The refusal's sentence, naming the accounts. `door` 'correction' words it
 * for a rättelse, whose lines come from the person, not from a mall.
 */
export function importVatWithoutBaseMessages(
  accounts: readonly string[],
  door: 'booking' | 'correction' = 'booking',
): { messageSv: string; messageEn: string } {
  const list = accounts.join(', ')
  if (door === 'correction') {
    return {
      messageSv:
        `Efter rättelsen skulle verifikationen ha importmoms på ${list} (ruta 60-62) men inget ` +
        'beskattningsunderlag i ruta 50, och då tar Skatteverket inte emot momsdeklarationen. Är köpet ' +
        'en import av varor från ett land utanför EU: ta med underlaget på 4545, 4546 eller 4547 i ' +
        'rättelsen. Är det ett köp av varor från ett annat EU-land eller av tjänster från utlandet är ' +
        'det omvänd skattskyldighet: rätta den utgående momsen till 2614, 2624 eller 2634.',
      messageEn:
        `After the correction the voucher would carry import VAT on ${list} (boxes 60-62) but no taxable ` +
        'amount in box 50, and Skatteverket refuses such a VAT return. For an import of goods from outside ' +
        'the EU, include the taxable amount on 4545, 4546 or 4547 in the correction. For goods from another ' +
        'EU country or services from abroad it is reverse charge: correct the output VAT to 2614, 2624 or 2634.',
    }
  }
  return {
    messageSv:
      `Verifikationen har importmoms på ${list} (ruta 60-62) men inget beskattningsunderlag i ruta 50, ` +
      'och då tar Skatteverket inte emot momsdeklarationen. Är köpet en import av varor från ett land ' +
      'utanför EU: bokför underlaget på 4545, 4546 eller 4547 i samma verifikation. Är det ett köp av ' +
      'varor från ett annat EU-land eller av tjänster från utlandet är det omvänd skattskyldighet: ' +
      'bokför den utgående momsen på 2614, 2624 eller 2634 i stället. Kommer raderna från en ' +
      'bokföringsmall, rätta mallen under Inställningar, Bokföringsmallar.',
    messageEn:
      `The voucher carries import VAT on ${list} (boxes 60-62) but no taxable amount in box 50, ` +
      'and Skatteverket refuses such a VAT return. For an import of goods from outside the EU, book the ' +
      'taxable amount on 4545, 4546 or 4547 in the same voucher. For goods from another EU country or ' +
      'services from abroad it is reverse charge: book the output VAT on 2614, 2624 or 2634 instead. If ' +
      'the lines come from a booking template, correct the template under Settings → Bookkeeping → Bookkeeping templates.',
  }
}

/**
 * The door's guard: refuses lines that book importmoms without its base, for
 * this company's chart. Reads the chart only when a line can carry importmoms.
 * A chart that cannot be read refuses nothing (logged): the momsdeklaration's
 * own FK005/FK006 check still stops such a period from being filed.
 */
export async function refuseImportVatWithoutBase(
  supabase: SupabaseClient,
  companyId: string,
  lines: readonly ImportVatShapeLine[],
): Promise<ImportVatWithoutBaseRefusal | null> {
  if (!mayCarryImportVat(lines)) return null
  let dynamic: DynamicVatAccounts
  try {
    dynamic = await fetchDynamicVatAccounts(supabase, companyId)
  } catch (err) {
    log.warn('importmoms base guard skipped: the chart could not be read', { companyId, err })
    return null
  }
  const accounts = importVatWithoutBase(lines, accountRutaFor(dynamic))
  if (!accounts) return null
  return {
    code: IMPORT_VAT_WITHOUT_BASE_CODE,
    details: { import_vat_accounts: accounts },
    ...importVatWithoutBaseMessages(accounts),
  }
}

/**
 * Verifikat whose 26xx lines are balances moved, not an affärshändelse's moms:
 * an opening balance's ingående saldon and a momsredovisning's clearing. A
 * credit on 2615 there needs no ruta 50 line beside it.
 */
const BALANCE_SOURCE_TYPES: ReadonlySet<string> = new Set(['opening_balance', 'vat_settlement'])

/**
 * The rättelse doors' guard (#94): refuses the lines a correction leaves in
 * the verifikat when they book importmoms without its base, worded for a
 * rättelse. `sourceType` is the corrected verifikat's own.
 */
export async function refuseCorrectedImportVatWithoutBase(
  supabase: SupabaseClient,
  companyId: string,
  sourceType: string | null | undefined,
  correctedLines: readonly ImportVatShapeLine[],
): Promise<ImportVatWithoutBaseRefusal | null> {
  if (sourceType && BALANCE_SOURCE_TYPES.has(sourceType)) return null
  const refusal = await refuseImportVatWithoutBase(supabase, companyId, correctedLines)
  if (!refusal) return null
  return { ...refusal, ...importVatWithoutBaseMessages(refusal.details.import_vat_accounts, 'correction') }
}

/** The same guard for a door that throws: ImportVatWithoutBaseError, a typed bookkeeping error. */
export async function assertCorrectedImportVatBase(
  supabase: SupabaseClient,
  companyId: string,
  sourceType: string | null | undefined,
  correctedLines: readonly ImportVatShapeLine[],
): Promise<void> {
  const refusal = await refuseCorrectedImportVatWithoutBase(supabase, companyId, sourceType, correctedLines)
  if (refusal) throw new ImportVatWithoutBaseError(refusal.details.import_vat_accounts, refusal.messageSv)
}
