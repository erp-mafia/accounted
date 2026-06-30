import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type {
  FiscalPeriod,
  JournalEntry,
  JournalEntryLine,
} from '@/types'
import type {
  NEDeclaration,
  NEDeclarationRutor,
  NEAccountMapping,
} from './types'

/**
 * NE-bilaga (Enskild Firma / Sole Proprietorship Declaration)
 *
 * Maps BAS account balances to NE declaration rutor (R1-R11) for
 * tax reporting to Skatteverket.
 *
 * Account mappings:
 * R1:  Försäljning med moms (3000-3599 excl 3100, 3700-3799)
 * R2:  Momsfria intäkter (3100, 3900-3969, 3970-3980, 3981-3999) - inkl gåvor utan motprestation
 * R3:  Bil/bostadsförmån (3200)
 * R4:  Ränteintäkter (8310-8330)
 * R5:  Varuinköp (4000-4990)
 * R6:  Övriga kostnader (5000-6990, 7970) - inkl avdragsgilla gåvor (5460)
 * R7:  Lönekostnader (7000-7699)
 * R8:  Räntekostnader (8400-8499)
 * R9:  Avskrivningar fastighet (7820)
 * R10: Avskrivningar övrigt (7700-7899 excl 7820)
 * R11: Årets resultat (calculated)
 *
 * Gift handling:
 * - Gåvor MED motprestation: R1 (momspliktig bytestransaktion)
 * - Gåvor UTAN motprestation: R2 via konto 3900
 * - Avdragsgilla gåvor: R6 via konto 5460
 */

/**
 * Account mapping configuration for NE declaration
 */
export const NE_ACCOUNT_MAPPINGS: NEAccountMapping[] = [
  {
    ruta: 'R1',
    description: 'Försäljning med moms (25%)',
    accountRanges: [
      { start: '3000', end: '3599', exclude: ['3100'] },
      { start: '3700', end: '3799' },
    ],
    isExpense: false,
  },
  {
    ruta: 'R2',
    description: 'Momsfria intäkter',
    accountRanges: [
      { start: '3100', end: '3100' },
      { start: '3900', end: '3969' }, // Övriga rörelseintäkter (inkl gåvor utan motprestation)
      { start: '3970', end: '3980' },
      { start: '3981', end: '3999' },
    ],
    isExpense: false,
  },
  {
    ruta: 'R3',
    description: 'Bil/bostadsförmån',
    accountRanges: [
      { start: '3200', end: '3299' },
    ],
    isExpense: false,
  },
  {
    ruta: 'R4',
    description: 'Ränteintäkter',
    accountRanges: [
      { start: '8310', end: '8330' },
    ],
    isExpense: false,
  },
  {
    ruta: 'R5',
    description: 'Varuinköp',
    accountRanges: [
      { start: '4000', end: '4990' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R6',
    description: 'Övriga kostnader',
    accountRanges: [
      { start: '5000', end: '6990' },
      { start: '7970', end: '7970' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R7',
    description: 'Lönekostnader',
    accountRanges: [
      { start: '7000', end: '7699' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R8',
    description: 'Räntekostnader',
    accountRanges: [
      { start: '8400', end: '8499' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R9',
    description: 'Avskrivningar fastighet',
    accountRanges: [
      { start: '7820', end: '7820' },
    ],
    isExpense: true,
  },
  {
    ruta: 'R10',
    description: 'Avskrivningar övrigt',
    accountRanges: [
      { start: '7700', end: '7899', exclude: ['7820'] },
    ],
    isExpense: true,
  },
]

/**
 * Check if an account number falls within a mapping's ranges
 */
function isAccountInMapping(accountNumber: string, mapping: NEAccountMapping): boolean {
  for (const range of mapping.accountRanges) {
    const num = accountNumber
    if (num >= range.start && num <= range.end) {
      // Check exclusions
      if (range.exclude && range.exclude.includes(num)) {
        continue
      }
      return true
    }
  }
  return false
}

/**
 * Round to nearest krona (whole number) for NE declaration
 */
function roundToKrona(value: number): number {
  return Math.round(value)
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

  // Fetch all posted journal entries with lines for this period.
  // Paginated: a period can exceed PostgREST's 1000-row cap, and a silent
  // truncation here would under-report the NE-bilaga tax declaration. PostgREST
  // ranges count parent rows, so the embedded lines come with each entry.
  const entries = await fetchAllRows<JournalEntry>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .in('status', ['posted', 'reversed'])
      .order('id', { ascending: true })
      .range(from, to)
  , { dedupeBy: (e) => e.id })

  // Fetch chart of accounts for account names
  const accounts = await fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to)
  )

  const accountNameMap = new Map<string, string>()
  for (const acc of accounts) {
    accountNameMap.set(acc.account_number, acc.account_name)
  }

  // Calculate balances per account
  const accountBalances = new Map<string, number>()

  for (const entry of (entries as JournalEntry[]) || []) {
    const lines = (entry.lines as JournalEntryLine[]) || []
    for (const line of lines) {
      const current = accountBalances.get(line.account_number) || 0
      // Net amount: debit - credit
      const netAmount = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
      accountBalances.set(line.account_number, current + netAmount)
    }
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

  // Process each account balance
  for (const [accountNumber, balance] of accountBalances) {
    // Skip zero balances
    if (Math.abs(balance) < 0.01) continue

    // Find which ruta this account belongs to
    for (const mapping of NE_ACCOUNT_MAPPINGS) {
      if (isAccountInMapping(accountNumber, mapping)) {
        // For revenue accounts (credit normal), negate the balance
        // For expense accounts (debit normal), use as-is
        // Net balance is debit - credit, so:
        // - Revenue accounts have negative net balance (credit > debit)
        // - Expense accounts have positive net balance (debit > credit)
        const amount = mapping.isExpense ? balance : -balance

        rutor[mapping.ruta] += amount

        breakdown[mapping.ruta].accounts.push({
          accountNumber,
          accountName: accountNameMap.get(accountNumber) || `Konto ${accountNumber}`,
          amount: roundToKrona(amount),
        })

        break // Account matched, no need to check other mappings
      }
    }
  }

  // Round all rutor to whole numbers
  for (const key of Object.keys(rutor) as (keyof NEDeclarationRutor)[]) {
    if (key !== 'R11') {
      rutor[key] = roundToKrona(rutor[key])
      breakdown[key].total = rutor[key]
    }
  }

  // Calculate R11 (Årets resultat)
  // Result = Revenue (R1+R2+R3+R4) - Expenses (R5+R6+R7+R8+R9+R10)
  const totalRevenue = rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4
  const totalExpenses = rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10
  rutor.R11 = totalRevenue - totalExpenses
  breakdown.R11.total = rutor.R11

  // Add warnings
  if (!(period as FiscalPeriod).is_closed) {
    warnings.push('Räkenskapsåret är inte stängt — deklarationen kan genereras, men siffrorna kan ändras om fler bokföringar görs.')
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
  }
}

/**
 * Get totals for display
 */
export function getNEDeclarationTotals(declaration: NEDeclaration): {
  totalRevenue: number
  totalExpenses: number
  netResult: number
} {
  const { rutor } = declaration

  return {
    totalRevenue: rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4,
    totalExpenses: rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10,
    netResult: rutor.R11,
  }
}
