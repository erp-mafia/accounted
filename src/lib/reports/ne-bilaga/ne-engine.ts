import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { FiscalPeriod } from '@/types'
import type {
  NEDeclaration,
  NEDeclarationRutor,
  NEAccountRange,
  NERuta,
} from './types'

/**
 * NE-bilaga (enskild näringsidkare): BAS account balances to rutor R1-R11.
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
 * periodiseringsfond (881x) refuses it too: an enskild firma claims one only
 * on the NE-bilaga.
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
  // 88xx (bokslutsdispositioner): BAS lists 881x, 886x, 888x and 889x as
  // (+/-); 882x-884x (koncernbidrag, gottgörelser) are absent from the table
  // and follow the same rule. 885x is listed on both R9 and R10: 8852
  // (byggnader och markanläggningar) to R9, the rest (immateriella, maskiner
  // och inventarier) to R10. 88xx and 89xx also get a named warning, and a
  // booked periodiseringsfond (881x) refuses the SRU file.
  signed('8800', '8849'),
  line('8850', '8851', 'R10'),
  line('8852', '8852', 'R9'),
  line('8853', '8859', 'R10'),
  signed('8860', '8899'),
  line('8900', '8989', 'R8'), // 89xx exkl. 899x
]

const REVENUE_RUTOR: ReadonlySet<NERuta> = new Set<NERuta>(['R1', 'R2', 'R3', 'R4'])

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

/** Bokslutsdispositioner and skatt (88xx, 89xx exkl. 899x): AB accounts an enskild firma should not use. */
function isNotForEnskildFirma(accountNumber: string): boolean {
  return accountNumber >= '8800' && accountNumber <= '8989'
}

/**
 * Periodiseringsfond (881x). An enskild firma never books one: avsättning and
 * återföring are made only on the NE-bilaga (R34, R32), the opposite of an AB.
 */
function isPeriodiseringsfond(accountNumber: string): boolean {
  return accountNumber >= '8810' && accountNumber <= '8819'
}

/**
 * Round to nearest krona (whole number) for NE declaration
 */
function roundToKrona(value: number): number {
  return Math.round(value)
}

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

  // Resolve entity_type: prefer company_settings, fall back to companies table (NOT NULL, always reliable)
  let entityType = settings?.entity_type
  if (!entityType) {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (companyError) throw new Error(`Failed to resolve entity type: ${companyError.message}`)
    entityType = company?.entity_type
  }

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
  const periodiseringsfond: Array<{ accountNumber: string; accountName: string; balance: number }> = []
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
    breakdown[ruta].accounts.push({ accountNumber, accountName, amount: roundToKrona(amount) })

    if (isPeriodiseringsfond(accountNumber)) {
      periodiseringsfond.push({ accountNumber, accountName, balance })
    } else if (isNotForEnskildFirma(accountNumber)) {
      warnings.push(
        `Konto ${accountNumber} ${accountName} (${describeBalance(balance)}) är ett konto för ` +
          `bokslutsdispositioner eller skatt som en enskild firma normalt inte använder. Beloppet ` +
          `ingår i ${ruta} enligt BAS kopplingstabell för NE; kontrollera bokföringen.`,
      )
    }
  }
  bookedResult = roundOre(bookedResult)

  // Round all rutor to whole numbers
  for (const key of Object.keys(rawRutor) as NERuta[]) {
    rutor[key] = roundToKrona(rawRutor[key])
    breakdown[key].total = rutor[key]
  }

  // Calculate R11 (Årets resultat)
  // Result = Revenue (R1+R2+R3+R4) - Expenses (R5+R6+R7+R8+R9+R10)
  const totalRevenue = rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4
  const totalExpenses = rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10
  rutor.R11 = totalRevenue - totalExpenses
  breakdown.R11.total = rutor.R11

  // R11 may differ from the booked result only by the whole-krona rounding of
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
  if (periodiseringsfond.length > 0) {
    sruBlockers.push(
      `${periodiseringsfond.length === 1 ? 'Konto' : 'Kontona'} ${nameAccounts(periodiseringsfond)} ` +
        'bokför en periodiseringsfond. En enskild firma bokför inte periodiseringsfond: avsättning och ' +
        'återföring görs bara i deklarationen (NE-bilagan R34 och R32). SRU-filen kan inte laddas ner ' +
        'förrän periodiseringsfonden är borttagen ur bokföringen.',
    )
  }
  warnings.unshift(...sruBlockers)

  // Add warnings
  if (!(period as FiscalPeriod).is_closed) {
    warnings.push('Räkenskapsåret är inte stängt; deklarationen kan genereras, men siffrorna kan ändras om fler bokföringar görs.')
  }

  if (rutor.R11 === 0 && totalRevenue === 0) {
    warnings.push('Inga bokförda intäkter eller kostnader hittades för perioden.')
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
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber: settings?.org_number || null,
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
