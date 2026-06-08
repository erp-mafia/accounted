import type { McpResource } from './types'

interface AccountSummary {
  account_number: string
  account_name: string
  account_class: number
  account_type: string
  normal_balance: string
  is_active: boolean
  default_vat_code: string | null
}

export const chartOfAccountsResource: McpResource = {
  uri: 'Accounted://chart-of-accounts',
  name: 'Chart of Accounts (BAS)',
  description: 'The active BAS chart of accounts for the current company, grouped by account class (1=assets, 2=liabilities/equity, 3=revenue, 4=COGS, 5-7=expenses, 8=financial). Use to look up account numbers before booking entries.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_class, account_type, normal_balance, is_active, default_vat_code')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })

    if (error) {
      throw new Error(`Failed to read chart of accounts: ${error.message}`)
    }

    const accounts = (data ?? []) as AccountSummary[]

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
