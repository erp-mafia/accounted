import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadBookedTaxAdjustments } from '@/lib/reports/tax-adjustments'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { formatCurrency } from '@/lib/utils'
import { roundOre, truncateToWholeKronor } from '@/lib/money'
import { companyIdentityFrom } from '@/lib/company/org-number'
import type { FiscalPeriod } from '@/types'
import type {
  NEBalansRuta,
  NEBalansRutor,
  NEDeclaration,
  NEDeclarationRutor,
  NEAccountRange,
  NERuta,
} from './types'
import { NE_ASSET_RUTOR, NE_LIABILITY_RUTOR } from './types'

/**
 * NE-bilaga (enskild näringsidkare): BAS account balances to rutor R1-R11
 * and the balansräkning B1-B16 (NE_BALANCE_RANGES below).
 *
 * Source: BAS kopplingstabell "NE - Inkomst av näringsverksamhet, Enskilda
 * näringsidkare - övriga" (NE_EJ_K1-Intervall-231002.xlsx, konton i BAS 2023,
 * bas.se/kontoplaner/sru/), the table for a firm that keeps the full BAS chart
 * rather than the förenklat årsbokslut one. A test pins every BAS 2026 class
 * 3-8 account (899x aside) to exactly one range.
 *
 * R11 is the arithmetic of the form, R1+R2+R3+R4 - R5..R10, and must equal
 * the booked result (BAS: 899x). The engine computes both from the same
 * trial balance; an account no range covers is named in a warning and the
 * SRU file is refused, rather than leaving it out of every ruta. A booked
 * periodiseringsfond (881x) or skatt (89xx) refuses it too: an enskild firma
 * claims the first only on the NE-bilaga, and the second is the owner's
 * private tax. Each ruta is in whole kronor, öre truncated toward zero
 * (SFL 22 kap. 1 §), as on INK2.
 */

/** A range whose balance goes to one ruta whatever its sign. */
function line(start: string, end: string, ruta: NERuta): NEAccountRange {
  return { start, end, income: ruta, cost: ruta }
}

/** BAS (+)/(-): a credit balance is a ränteintäkt (R4), a debit balance a räntekostnad (R8). */
function signed(start: string, end: string): NEAccountRange {
  return { start, end, income: 'R4', cost: 'R8' }
}

/**
 * Disjoint, sorted ranges: an account is in at most one, so order does not
 * matter. BAS lists 30xx-37xx and 39xx on both R1 and R2 ("the ruta follows
 * what is booked on the account"): the split below follows the account's VAT
 * status, R1 for momspliktig (export, VMB and omvänd moms included) and R2
 * for momsfri, with 3100 and 39xx on R2 unless the account says momspliktig.
 * R3 (bil- och bostadsförmån) has no BAS account.
 */
export const NE_ACCOUNT_RANGES: readonly NEAccountRange[] = [
  line('3000', '3003', 'R1'),
  line('3004', '3004', 'R2'), // Försäljning inom Sverige, momsfri
  line('3005', '3099', 'R1'),
  line('3100', '3100', 'R2'),
  line('3101', '3403', 'R1'),
  line('3404', '3404', 'R2'), // Egna uttag, momsfria
  line('3405', '3799', 'R1'),
  line('3800', '3899', 'R4'), // 38xx
  line('3900', '3912', 'R2'),
  line('3913', '3914', 'R1'), // Frivilligt och övriga momspliktiga hyresintäkter
  line('3915', '3999', 'R2'),
  line('4000', '4999', 'R5'), // 40xx-49xx
  line('5000', '6999', 'R6'), // 50xx-69xx
  line('7000', '7699', 'R7'), // 70xx-76xx
  line('7710', '7719', 'R10'),
  line('7720', '7729', 'R9'),
  line('7730', '7739', 'R10'),
  line('7740', '7749', 'R8'),
  line('7760', '7769', 'R10'),
  line('7770', '7779', 'R9'),
  line('7780', '7789', 'R10'),
  line('7790', '7799', 'R8'),
  line('7810', '7819', 'R10'),
  line('7820', '7829', 'R9'),
  line('7830', '7839', 'R10'),
  line('7840', '7849', 'R9'),
  line('7900', '7999', 'R8'), // 79xx
  line('8010', '8019', 'R4'),
  signed('8020', '8039'),
  line('8070', '8089', 'R8'),
  line('8110', '8119', 'R4'),
  signed('8120', '8139'),
  line('8170', '8189', 'R8'),
  line('8200', '8219', 'R4'),
  // 822x(+/-), 823x(+) on R4 and unsigned on R8, 824x(+/-): signed throughout.
  signed('8220', '8249'),
  line('8250', '8269', 'R4'),
  line('8270', '8289', 'R8'),
  signed('8290', '8299'),
  line('8300', '8319', 'R4'),
  signed('8320', '8339'),
  line('8340', '8349', 'R4'),
  signed('8350', '8359'),
  line('8360', '8369', 'R4'),
  line('8370', '8389', 'R8'),
  line('8390', '8399', 'R4'),
  line('8400', '8429', 'R8'),
  signed('8430', '8439'),
  line('8440', '8449', 'R4'),
  signed('8450', '8459'),
  line('8460', '8469', 'R8'),
  line('8480', '8489', 'R8'),
  signed('8490', '8499'),
  // 88xx (bokslutsdispositioner) exactly as the table lists it: 881x, 886x,
  // 888x and 889x (+/-). 880x, 882x-884x (koncernbidrag, gottgörelser) and
  // 887x are absent, so they have no ruta and refuse the SRU file. 885x is
  // listed on both R9 and R10, to follow what is booked on it: 8852
  // (byggnader och markanläggningar) to R9; 8851 (immateriella), 8853
  // (maskiner och inventarier) and the group account 8850 to R10. The rest of
  // 88xx gets a named warning; a booked periodiseringsfond (881x) or skatt
  // (89xx) refuses the SRU file.
  signed('8810', '8819'),
  line('8850', '8851', 'R10'),
  line('8852', '8852', 'R9'),
  line('8853', '8859', 'R10'),
  signed('8860', '8869'),
  signed('8880', '8899'),
  line('8900', '8989', 'R8'), // 89xx exkl. 899x
]

const REVENUE_RUTOR: ReadonlySet<NERuta> = new Set<NERuta>(['R1', 'R2', 'R3', 'R4'])

/**
 * Balansräkning B1-B16 from the same BAS kopplingstabell (NE_EJ_K1, konton i
 * BAS 2023). Disjoint and sorted. B10 Eget kapital lists 201x and 205x, but
 * the form defines it as tillgångar - skulder, so it is computed, not summed.
 * B14 Skatteskulder lists no account ("Inget redovisas här"): an enskild
 * firma's tax is the owner's own. A balance account no range covers (25xx,
 * 240x, 202x-204x, 206x-209x) is named in a warning and stays out of B11-B16,
 * which leaves it inside B10.
 */
export const NE_BALANCE_RANGES: ReadonlyArray<{ start: string; end: string; ruta: NEBalansRuta }> = [
  { start: '1000', end: '1099', ruta: 'B1' },
  { start: '1100', end: '1129', ruta: 'B2' },
  { start: '1130', end: '1149', ruta: 'B3' },
  { start: '1150', end: '1179', ruta: 'B2' },
  { start: '1180', end: '1189', ruta: 'B3' },
  { start: '1190', end: '1199', ruta: 'B2' },
  { start: '1200', end: '1290', ruta: 'B4' },
  { start: '1291', end: '1291', ruta: 'B3' },
  { start: '1292', end: '1299', ruta: 'B4' },
  { start: '1300', end: '1399', ruta: 'B5' },
  { start: '1400', end: '1499', ruta: 'B6' },
  { start: '1500', end: '1599', ruta: 'B7' },
  { start: '1600', end: '1899', ruta: 'B8' },
  { start: '1900', end: '1999', ruta: 'B9' },
  { start: '2010', end: '2019', ruta: 'B10' },
  { start: '2050', end: '2059', ruta: 'B10' },
  { start: '2100', end: '2199', ruta: 'B11' },
  { start: '2200', end: '2299', ruta: 'B12' },
  { start: '2300', end: '2399', ruta: 'B13' },
  { start: '2410', end: '2419', ruta: 'B13' },
  { start: '2420', end: '2439', ruta: 'B16' },
  { start: '2440', end: '2449', ruta: 'B15' },
  { start: '2450', end: '2459', ruta: 'B16' },
  { start: '2460', end: '2479', ruta: 'B15' },
  { start: '2480', end: '2489', ruta: 'B13' },
  { start: '2490', end: '2499', ruta: 'B16' },
  { start: '2600', end: '2999', ruta: 'B16' },
]

/** The balansräkning row a balance account goes to, or null when no range covers it. */
export function neBalansRutaForAccount(accountNumber: string): NEBalansRuta | null {
  if (!isAccountNumber(accountNumber)) return null
  return NE_BALANCE_RANGES.find((r) => accountNumber >= r.start && accountNumber <= r.end)?.ruta ?? null
}

const BALANS_RUTOR: readonly NEBalansRuta[] = [...NE_ASSET_RUTOR, 'B10', ...NE_LIABILITY_RUTOR]

/**
 * B1-B16 from balance accounts' closing balances (debit-positive). Assets
 * are filed debit-positive, B11-B16 credit-positive, each row in whole
 * kronor with the öre dropped; B10 is the difference of those rows, so the
 * balansräkning the form shows always ties. Year-end's result transfer only
 * moves the result between 2010 and the result accounts, so the pre-closing
 * books give the same assets and liabilities as the closed ones.
 */
export function neBalansFromBalances(
  balances: ReadonlyMap<string, number>,
  accountNames: ReadonlyMap<string, string>,
): {
  balans: NEBalansRutor
  breakdown: NEDeclaration['balansBreakdown']
  unmapped: Array<{ accountNumber: string; accountName: string; balance: number }>
} {
  const raw = Object.fromEntries(BALANS_RUTOR.map((ruta) => [ruta, 0])) as Record<NEBalansRuta, number>
  const breakdown = Object.fromEntries(
    BALANS_RUTOR.map((ruta) => [ruta, { accounts: [] as NEDeclaration['balansBreakdown']['B1']['accounts'], total: 0 }]),
  ) as NEDeclaration['balansBreakdown']
  const unmapped: Array<{ accountNumber: string; accountName: string; balance: number }> = []
  for (const [accountNumber, balance] of balances) {
    if (Math.abs(balance) < 0.01 || !/^[12]/.test(accountNumber)) continue
    const accountName = accountNames.get(accountNumber) || `Konto ${accountNumber}`
    const ruta = neBalansRutaForAccount(accountNumber)
    // B10 is computed below as tillgångar minus skulder, so an equity account
    // needs no row. Every BAS class 20 account is eget kapital, including the
    // aktiebolag ones (2091, 2099) that books imported from another system
    // carry; the table names only 2010-2019 and 2050-2059.
    if (ruta === 'B10' || accountNumber.startsWith('20')) continue
    if (!ruta) {
      unmapped.push({ accountNumber, accountName, balance })
      continue
    }
    const amount = NE_ASSET_RUTOR.includes(ruta) ? balance : -balance
    raw[ruta] += amount
    breakdown[ruta].accounts.push({ accountNumber, accountName, amount: truncateToWholeKronor(amount) })
  }
  const balans = Object.fromEntries(
    BALANS_RUTOR.map((ruta) => [ruta, truncateToWholeKronor(raw[ruta])]),
  ) as unknown as NEBalansRutor
  balans.B10 =
    NE_ASSET_RUTOR.reduce((sum, ruta) => sum + balans[ruta], 0)
    - NE_LIABILITY_RUTOR.reduce((sum, ruta) => sum + balans[ruta], 0)
  for (const ruta of BALANS_RUTOR) breakdown[ruta].total = balans[ruta]
  return { balans, breakdown, unmapped }
}

/**
 * The ruta an account balance goes to, or null when no range covers the
 * account. `balance` is debit minus credit.
 */
export function neRutaForAccount(accountNumber: string, balance: number): NERuta | null {
  if (!isAccountNumber(accountNumber)) return null
  const range = NE_ACCOUNT_RANGES.find((r) => accountNumber >= r.start && accountNumber <= r.end)
  if (!range) return null
  return balance < 0 ? range.income : range.cost
}

/** An income statement account: class 3-8, except the result accounts 899x. */
function isResultAccount(accountNumber: string): boolean {
  return /^[3-8]/.test(accountNumber) && !accountNumber.startsWith('899')
}

/** Bokslutsdispositioner (88xx): AB accounts an enskild firma normally does not use. */
function isBokslutsdisposition(accountNumber: string): boolean {
  return accountNumber >= '8800' && accountNumber <= '8899'
}

/**
 * Accounts an enskild firma never books, though the table gives them a ruta.
 * Each refuses the SRU file; the amount stays in its ruta, so R11 is still
 * the booked result.
 */
const NEVER_BOOKED_BY_ENSKILD_FIRMA: ReadonlyArray<{ start: string; end: string; explain: string }> = [
  {
    // Avsättning and återföring are made only on the NE-bilaga, the opposite of an AB.
    start: '8810',
    end: '8819',
    explain:
      'bokför en periodiseringsfond. En enskild firma bokför inte periodiseringsfond: avsättning och ' +
      'återföring görs bara i deklarationen (NE-bilagan R34 och R32). SRU-filen kan inte laddas ner ' +
      'förrän periodiseringsfonden är borttagen ur bokföringen.',
  },
  {
    // Preliminär- and slutskatt are the owner's private tax: an eget uttag (2013), never a cost.
    start: '8900',
    end: '8989',
    explain:
      'bokför skatt som en kostnad. En enskild firma bokför inte skatt i resultaträkningen: preliminärskatt ' +
      'och slutlig skatt är ägarens egen skatt och bokförs som eget uttag (2013), återbetald skatt som ' +
      'egen insättning (2018). SRU-filen kan inte laddas ner förrän skatten är ombokad.',
  },
]

/** "1 234,56 kr debet": a balance as a bookkeeper reads it. */
function describeBalance(balance: number): string {
  const side = balance < 0 ? 'kredit' : 'debet'
  return `${formatCurrency(Math.abs(balance), 'SEK', { minimumFractionDigits: 2 })} ${side}`
}

/** "8470 Egen post (100,00 kr debet), 8811 ...": accounts named for a warning. */
function nameAccounts(accounts: Array<{ accountNumber: string; accountName: string; balance: number }>): string {
  return accounts
    .map((a) => `${a.accountNumber} ${a.accountName} (${describeBalance(a.balance)})`)
    .join(', ')
}

/**
 * Generate NE declaration for a fiscal period
 */
export async function generateNEDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<NEDeclaration> {

  // Fetch fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Fetch company settings
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, entity_type, address_line1, postal_code, city, email')
    .eq('company_id', companyId)
    .single()

  const { orgNumber, entityType } = await companyIdentityFrom(supabase, companyId, settings)

  if (entityType !== 'enskild_firma') {
    throw new Error('NE declaration is only for enskild firma (sole proprietorship)')
  }

  // R1-R11 are an income statement, so read the PRE-CLOSING books. The
  // resultatavslut zeroes every P&L account against 2019/2099 at year-end, and
  // NE-bilaga is always filed after bokslut, so including it would report an
  // empty näringsverksamhet. 'exclude-final' drops only the result transfer
  // into equity (ours, or one booked in the previous system or by hand):
  // avskrivningar and other bokslut entries also carry source_type 'year_end'
  // and belong on the form.
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'exclude-final',
  })

  const accountNameMap = new Map<string, string>()
  const accountBalances = new Map<string, number>()
  for (const row of trialBalance.rows) {
    accountNameMap.set(row.account_number, row.account_name)
    accountBalances.set(
      row.account_number,
      (Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0),
    )
  }

  // Map account balances to NE rutor
  const rutor: NEDeclarationRutor = {
    R1: 0,
    R2: 0,
    R3: 0,
    R4: 0,
    R5: 0,
    R6: 0,
    R7: 0,
    R8: 0,
    R9: 0,
    R10: 0,
    R11: 0,
  }

  const breakdown: Record<keyof NEDeclarationRutor, {
    accounts: Array<{ accountNumber: string; accountName: string; amount: number }>
    total: number
  }> = {
    R1: { accounts: [], total: 0 },
    R2: { accounts: [], total: 0 },
    R3: { accounts: [], total: 0 },
    R4: { accounts: [], total: 0 },
    R5: { accounts: [], total: 0 },
    R6: { accounts: [], total: 0 },
    R7: { accounts: [], total: 0 },
    R8: { accounts: [], total: 0 },
    R9: { accounts: [], total: 0 },
    R10: { accounts: [], total: 0 },
    R11: { accounts: [], total: 0 },
  }

  const warnings: string[] = []
  const unmapped: Array<{ accountNumber: string; accountName: string; balance: number }> = []
  const neverBooked = NEVER_BOOKED_BY_ENSKILD_FIRMA.map(() =>
    [] as Array<{ accountNumber: string; accountName: string; balance: number }>,
  )
  // Unrounded ruta sums and the booked result, both in öre, from the same rows.
  const rawRutor: Record<NERuta, number> = {
    R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, R8: 0, R9: 0, R10: 0,
  }
  let bookedResult = 0

  for (const [accountNumber, balance] of accountBalances) {
    if (Math.abs(balance) < 0.01) continue
    if (!isResultAccount(accountNumber)) continue

    bookedResult -= balance
    const accountName = accountNameMap.get(accountNumber) || `Konto ${accountNumber}`
    const ruta = neRutaForAccount(accountNumber, balance)
    if (!ruta) {
      unmapped.push({ accountNumber, accountName, balance })
      continue
    }

    // Net balance is debit - credit: revenue rutor carry it negated, cost
    // rutor as is, so a credit on a cost account reduces its ruta.
    const amount = REVENUE_RUTOR.has(ruta) ? -balance : balance
    rawRutor[ruta] += amount
    breakdown[ruta].accounts.push({ accountNumber, accountName, amount: truncateToWholeKronor(amount) })

    const never = NEVER_BOOKED_BY_ENSKILD_FIRMA.findIndex(
      (r) => accountNumber >= r.start && accountNumber <= r.end,
    )
    if (never >= 0) {
      neverBooked[never].push({ accountNumber, accountName, balance })
    } else if (isBokslutsdisposition(accountNumber)) {
      warnings.push(
        `Konto ${accountNumber} ${accountName} (${describeBalance(balance)}) är ett konto för ` +
          `bokslutsdispositioner som en enskild firma normalt inte använder. Beloppet ` +
          `ingår i ${ruta} enligt BAS kopplingstabell för NE; kontrollera bokföringen.`,
      )
    }
  }
  bookedResult = roundOre(bookedResult)

  // Whole kronor, öre truncated toward zero (SFL 22 kap. 1 §)
  for (const key of Object.keys(rawRutor) as NERuta[]) {
    rutor[key] = truncateToWholeKronor(rawRutor[key])
    breakdown[key].total = rutor[key]
  }

  // Calculate R11 (Årets resultat)
  // Result = Revenue (R1+R2+R3+R4) - Expenses (R5+R6+R7+R8+R9+R10)
  const totalRevenue = rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4
  const totalExpenses = rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10
  rutor.R11 = totalRevenue - totalExpenses
  breakdown.R11.total = rutor.R11

  // R11 may differ from the booked result only by the öre truncation of
  // R1-R10: compared unrounded, the two are equal to the öre unless an
  // account is missing from the rutor.
  const unroundedR11 = roundOre(
    rawRutor.R1 + rawRutor.R2 + rawRutor.R3 + rawRutor.R4 -
      (rawRutor.R5 + rawRutor.R6 + rawRutor.R7 + rawRutor.R8 + rawRutor.R9 + rawRutor.R10),
  )
  const unexplained = roundOre(bookedResult - unroundedR11)
  const sruBlockers: string[] = []
  if (unmapped.length > 0 || unexplained !== 0) {
    const parts: string[] = []
    if (unmapped.length > 0) {
      const named = nameAccounts(unmapped)
      parts.push(
        unmapped.length === 1
          ? `Konto ${named} hör inte till någon ruta i NE-bilagan.`
          : `Kontona ${named} hör inte till någon ruta i NE-bilagan.`,
      )
    }
    if (unexplained !== 0) {
      parts.push(
        `R11 blir ${formatCurrency(rutor.R11)} men bokfört resultat är ${formatCurrency(bookedResult, 'SEK', { minimumFractionDigits: 2 })}.`,
      )
    }
    parts.push('SRU-filen kan inte laddas ner förrän beloppen är bokförda på BAS-konton som hör till en ruta.')
    sruBlockers.push(parts.join(' '))
  }
  NEVER_BOOKED_BY_ENSKILD_FIRMA.forEach((r, i) => {
    const accounts = neverBooked[i]
    if (accounts.length === 0) return
    sruBlockers.push(`${accounts.length === 1 ? 'Konto' : 'Kontona'} ${nameAccounts(accounts)} ${r.explain}`)
  })
  warnings.unshift(...sruBlockers)

  // Balansräkning B1-B16 from the same rows.
  const balansResult = neBalansFromBalances(accountBalances, accountNameMap)
  if (balansResult.unmapped.length > 0) {
    const named = nameAccounts(balansResult.unmapped)
    warnings.push(
      `${balansResult.unmapped.length === 1 ? 'Konto' : 'Kontona'} ${named} hör inte till någon rad i NE-bilagans balansräkning ` +
        `(B14 Skatteskulder ska vara tom för en enskild firma: ägarens skatt bokförs som eget uttag, 2013). ` +
        `Beloppet ingår därför i B10 Eget kapital; kontrollera bokföringen.`,
    )
  }

  // Add warnings
  if (!(period as FiscalPeriod).is_closed) {
    warnings.push('Räkenskapsåret är inte stängt; deklarationen kan genereras, men siffrorna kan ändras om fler bokföringar görs.')
  }

  if (rutor.R11 === 0 && totalRevenue === 0) {
    warnings.push('Inga bokförda intäkter eller kostnader hittades för perioden.')
  }

  // Sida 2 R13 and R14: representation, föreningsavgifter, böter and the
  // skattekonto's kostnadsränta added back, its inkomstränta taken out
  // (Skatteverket, "Skattemässiga justeringar" for the NE-bilaga), read the
  // way INK2S reads them, from the same trial balance as R1-R11.
  const adjustments = await loadBookedTaxAdjustments(supabase, companyId, fiscalPeriodId, entityType, trialBalance.rows)
  const sida2Items = (type: 'non_deductible_expense' | 'non_taxable_income') =>
    adjustments.items
      .filter((item) => item.included && item.amount > 0 && item.adjustmentType === type)
      .map((item) => ({ accountNumber: item.accountNumber, description: item.description, amount: item.amount }))
  const sida2 = {
    R12: rutor.R11,
    R13: truncateToWholeKronor(adjustments.nonDeductibleExpenses),
    R14: truncateToWholeKronor(adjustments.nonTaxableIncome),
  }

  return {
    fiscalYear: {
      id: period.id,
      name: period.name,
      start: period.period_start,
      end: period.period_end,
      isClosed: period.is_closed,
    },
    rutor,
    breakdown,
    balans: balansResult.balans,
    balansBreakdown: balansResult.breakdown,
    sida2,
    sida2Breakdown: {
      R13: { items: sida2Items('non_deductible_expense'), total: sida2.R13 },
      R14: { items: sida2Items('non_taxable_income'), total: sida2.R14 },
    },
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber,
      entityType,
      addressLine1: settings?.address_line1 || null,
      postalCode: settings?.postal_code || null,
      city: settings?.city || null,
      email: settings?.email || null,
    },
    warnings,
    bookedResult,
    sruBlockers,
  }
}
