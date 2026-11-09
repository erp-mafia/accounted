/** Entirely synthetic inputs. No customer exports, descriptions or identifiers. */
import { BAS_REFERENCE } from '../../src/lib/bookkeeping/bas-reference'
import { roundOre } from '../../src/lib/money'

export const FIXTURE_VERSION = 2
export const YEAR_ENTRY_COUNTS = [75, 75, 200, 225, 275, 550, 550, 400, 550, 325]
export const FIXTURE_NAME = 'E2E Ten Year Consulting AB'
export const DOCUMENT_COUNT = 1400

export interface SyntheticInvoice {
  kind: 'customer' | 'supplier'
  index: number
  date: string
  due: string
  amount: number
  unpaid: boolean
  registration: string
  payment: string | null
}

/** Generate balanced SIE inputs with paid, unpaid and inactive-account history. */
export function buildDataset(lastYear: number) {
  const total = YEAR_ENTRY_COUNTS.reduce((sum, count) => sum + count, 0)
  const expenses = BAS_REFERENCE.filter(account => account.account_type === 'expense' && account.account_class <= 6)
    .slice(0, 80).map(account => account.account_number)
  const revenue = BAS_REFERENCE.filter(account => account.account_type === 'revenue' && account.account_class === 3)
    .slice(0, 20).map(account => account.account_number)
  const accounts = [...new Set(['1510', '1930', '2081', '2440', '2611', '2641', '3011', '5410', '5420', '6570', ...expenses, ...revenue])]
  let supplierIndex = 0
  let customerIndex = 0
  let processed = 0
  const years = YEAR_ENTRY_COUNTS.map((count, yearIndex) => {
    const year = lastYear - 9 + yearIndex
    const invoices: SyntheticInvoice[] = []
    const entries: string[] = []
    /** Append one balanced voucher with a stable source number. */
    function add(description: string, date: string, lines: [string, number][]) {
      if (lines.reduce((sum, [, amount]) => sum + Math.round(amount * 100), 0) !== 0) {
        throw new Error('Synthetic voucher must balance to the ore')
      }
      entries.push(`#VER A ${entries.length + 1} ${date.replaceAll('-', '')} "${description}"\n{\n`
        + lines.map(([account, amount]) => `#TRANS ${account} {} ${amount}`).join('\n') + '\n}')
    }
    for (const kind of ['supplier', 'customer'] as const) {
      const target = kind === 'supplier' ? 450 : 50
      const number = Math.floor((processed + count) * target / total) - Math.floor(processed * target / total)
      for (let i = 0; i < number; i++) {
        const index = kind === 'supplier' ? supplierIndex++ : customerIndex++
        const unpaid = yearIndex === 9 && i === number - 1
        const month = unpaid ? 12 : 1 + i % 10
        const date = `${year}-${String(month).padStart(2, '0')}-03`
        const due = unpaid ? `${year + 1}-01-03` : `${year}-${String(month).padStart(2, '0')}-28`
        const amount = 1000 + index * 4
        const registration = `E2E ${kind} ${index} registration`
        const payment = unpaid ? null : `E2E ${kind} ${index} payment`
        const net = roundOre(amount / 1.25)
        const vat = roundOre(amount - net)
        add(registration, date, kind === 'supplier'
          ? [['5420', net], ['2641', vat], ['2440', -amount]]
          : [['1510', amount], ['3011', -net], ['2611', -vat]])
        if (payment) add(payment, `${year}-${String(month).padStart(2, '0')}-20`, kind === 'supplier'
          ? [['2440', amount], ['1930', -amount]] : [['1930', amount], ['1510', -amount]])
        invoices.push({ kind, index, date, due, amount, unpaid, registration, payment })
      }
    }
    // A historical equity account with net zero and no current-year vouchers
    // makes the inactive-account filter observable in the real ledger.
    if (yearIndex === 0) {
      add('E2E temporary capital', `${year}-01-01`, [['1930', 100], ['2081', -100]])
      add('E2E capital returned', `${year}-01-02`, [['2081', 100], ['1930', -100]])
    }
    while (entries.length < count) {
      const index = entries.length
      const date = `${year}-${String(1 + index % 12).padStart(2, '0')}-${String(1 + index % 27).padStart(2, '0')}`
      const amount = 100 + index * 5
      const accountIndex = Math.floor(index / 2)
      add(`E2E ${year} voucher ${index + 1}`, date, index % 2
        ? [[expenses[accountIndex % expenses.length], amount], ['1930', -amount]]
        : [['1930', amount], [revenue[accountIndex % revenue.length], -amount]])
    }
    processed += count
    const content = `#FLAGGA 0\n#PROGRAM "Accounted E2E synthetic" 1\n#SIETYP 4\n#FNAMN "${FIXTURE_NAME}"\n#RAR 0 ${year}0101 ${year}1231\n`
      + accounts.map(account => `#KONTO ${account} "Synthetic ${account}"`).join('\n') + '\n' + entries.join('\n')
    return { year, content, invoices, count }
  })
  return { years, accounts, total }
}
