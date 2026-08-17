import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { McpResource } from './types'

interface AccountSummary {
  account_number: string
  account_name: string
  account_class: number
  account_type: string
  normal_balance: string
  is_active: boolean
  default_vat_code: string | null
  default_vat_rate: number | null
  default_vat_treatment: string | null
}

export const chartOfAccountsResource: McpResource = {
  uri: 'Accounted://chart-of-accounts',
  name: 'Chart of Accounts (BAS)',
  description: 'The active BAS chart of accounts for the current company, grouped by account class (1=assets, 2=liabilities/equity, 3=revenue, 4=COGS, 5-7=expenses, 8=financial). Use to look up account numbers before booking entries.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    // Paginated (fetchAllRows): PostgREST silently caps un-ranged selects at
    // 1000 rows and a full BAS 2026 chart holds ~1290 accounts. account_number
    // is unique per company, so it doubles as the stable paging order.
    let accounts: AccountSummary[]
    try {
      accounts = await fetchAllRows<AccountSummary>(({ from, to }) =>
        supabase
          .from('chart_of_accounts')
          .select('account_number, account_name, account_class, account_type, normal_balance, is_active, default_vat_code, default_vat_rate, default_vat_treatment')
          .eq('company_id', companyId)
          .order('account_number', { ascending: true })
          .range(from, to)
      )
    } catch (error) {
      throw new Error(
        `Failed to read chart of accounts: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }

    const byClass: Record<number, AccountSummary[]> = {}
    for (const a of accounts) {
      if (!byClass[a.account_class]) byClass[a.account_class] = []
      byClass[a.account_class].push(a)
    }

    return {
      total: accounts.length,
      classes: {
        '1': { label: 'Tillgångar', accounts: byClass[1] ?? [] },
        '2': { label: 'Eget kapital och skulder', accounts: byClass[2] ?? [] },
        '3': { label: 'Rörelseintäkter', accounts: byClass[3] ?? [] },
        '4': { label: 'Material- och varukostnader', accounts: byClass[4] ?? [] },
        '5': { label: 'Övriga externa rörelseutgifter', accounts: byClass[5] ?? [] },
        '6': { label: 'Övriga externa rörelseutgifter (forts.)', accounts: byClass[6] ?? [] },
        '7': { label: 'Personalkostnader', accounts: byClass[7] ?? [] },
        '8': { label: 'Finansiella poster', accounts: byClass[8] ?? [] },
      },
    }
  },
}
