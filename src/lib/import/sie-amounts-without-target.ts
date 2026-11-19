import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { isSystemAccount } from './account-mapper'
import { formatVoucherRef, getEffectiveOpeningBalances } from './sie-parser'
import type { ParsedSIEFile } from './types'

/**
 * Which source accounts an SIE import needs a target account for, and the
 * refusal when one is missing. One definition for every door: submitSIEJob,
 * the MCP preflight and the worker's snapshot all reach it through
 * validateSIEJobInput, and the provider migration reads the same answer to
 * decide which source-system accounts its mapping page shows.
 *
 * WHY. prepareSIEVouchers skips a whole voucher when one of its lines is on
 * an account without a target, and the opening balance leaves such an account
 * out and books the remainder on the result account. The gate asked only that
 * SOME account in the file was mapped, so a list that missed accounts with
 * amounts passed, and the import finished as completed with a warning:
 *
 *   - 2026-11-11, MCP: an agent sent 14 of the 47 mappings the file needed;
 *     410 of 411 vouchers were skipped and the import read "completed".
 *   - 2026-10-22, provider migration: the fetch hid every 0xxx account from
 *     the mapping page; the company booked its supplier costs on 0999, so 65
 *     paid supplier invoices never reached 1930 and 2641.
 *
 * THE RULE. A voucher may be skipped for a missing target only when it moves
 * no balance: every account on it nets to zero inside the voucher. That is
 * what Fortnox's 0099 rows are (the same amount in debit and credit on one
 * account, or zero amounts), and skipping them leaves every balance equal to
 * the file's. Any other voucher on such an account, and any opening balance
 * on one, is an amount the file states and the books would lack: the import
 * stops and names the accounts.
 *
 * An opening balance needs its target also when the year continues earlier
 * bookkeeping and the file's IB is not booked (the job's prior_activity,
 * decided in the database after this gate): the comparison of that IB with
 * the carried-forward balance leaves an account without a target out, and
 * then reports a difference the books do not have.
 */

/** Where a source account carries amounts the import books. */
export interface SIEAccountAmounts {
  /** Vouchers that move a balance and have a line on the account. */
  vouchers: number
  /** The first of them, as the file names it ("E12"). */
  firstVoucher: string | null
  /** The account's opening balance in the file; 0 when the import books none. */
  openingBalance: number
}

export interface SIEAmountSelection {
  importTransactions: boolean
  importOpeningBalances: boolean
}

/**
 * A voucher moves a balance when some account on it does not net to zero,
 * per object list: 100 moved from one project to another on the same account
 * changes no account balance and still changes each project's.
 */
function movesABalance(lines: ReadonlyArray<{ account: string; amount: number; dimensions?: Record<string, string> }>): boolean {
  const net = new Map<string, number>()
  for (const line of lines) {
    const objects = Object.entries(line.dimensions ?? {}).sort(([a], [b]) => a.localeCompare(b))
    const key = `${line.account}\u0000${JSON.stringify(objects)}`
    net.set(key, (net.get(key) ?? 0) + line.amount)
  }
  for (const amount of net.values()) if (roundOre(amount) !== 0) return true
  return false
}

/**
 * Every source account on a voucher that moves a balance (whatever the line's
 * own amount: one line without a target skips the whole voucher) and every
 * account with a non-zero opening balance, for what the import was asked to
 * book. An account that is absent here can go without a target and no balance
 * changes.
 */
export function sieAccountsCarryingAmounts(
  parsed: ParsedSIEFile,
  selection: SIEAmountSelection,
): Map<string, SIEAccountAmounts> {
  const carrying = new Map<string, SIEAccountAmounts>()
  const entryFor = (account: string): SIEAccountAmounts => {
    let entry = carrying.get(account)
    if (!entry) carrying.set(account, (entry = { vouchers: 0, firstVoucher: null, openingBalance: 0 }))
    return entry
  }
  if (selection.importTransactions) {
    for (const [index, voucher] of parsed.vouchers.entries()) {
      if (!movesABalance(voucher.lines)) continue
      for (const account of new Set(voucher.lines.map((line) => line.account))) {
        const entry = entryFor(account)
        entry.vouchers += 1
        entry.firstVoucher ??= formatVoucherRef(voucher, index + 1)
      }
    }
  }
  if (selection.importOpeningBalances) {
    for (const balance of getEffectiveOpeningBalances(parsed).balances) {
      if (roundOre(balance.amount) === 0) continue
      const entry = entryFor(balance.account)
      entry.openingBalance = roundOre(entry.openingBalance + balance.amount)
    }
  }
  return carrying
}

/**
 * The accounts a door offers for a target (the provider fetch, the MCP
 * preflight): every account of the files except a source-system account
 * (0xxx, Fortnox 0099) that carries no amount in any of them. Its vouchers
 * move no balance and are skipped; one that does carry amounts (a company
 * that books costs on 0999) is offered like any other account.
 */
export function sieAccountsOfferedForMapping<A extends { number: string }>(accounts: readonly A[], files: readonly ParsedSIEFile[]): A[] {
  const carrying = new Set(files.flatMap((parsed) =>
    [...sieAccountsCarryingAmounts(parsed, { importTransactions: true, importOpeningBalances: true }).keys()]))
  return accounts.filter((account) => !isSystemAccount(account.number) || carrying.has(account.number))
}

/** One account the refusal names. */
export interface SIEAccountWithoutTarget extends SIEAccountAmounts {
  account: string
  name: string
}

/** The accounts that carry amounts and have no target, sorted by account number. */
export function findSIEAmountsWithoutTarget(
  parsed: ParsedSIEFile,
  mapped: ReadonlySet<string>,
  selection: SIEAmountSelection,
): SIEAccountWithoutTarget[] {
  const names = new Map(parsed.accounts.map((account) => [account.number, account.name]))
  return [...sieAccountsCarryingAmounts(parsed, selection)]
    .filter(([account]) => !mapped.has(account))
    .map(([account, amounts]) => ({ account, name: names.get(account) ?? '', ...amounts }))
    .sort((a, b) => a.account.localeCompare(b.account))
}

/** How many accounts the sentence names before it counts the rest. */
const ACCOUNTS_NAMED = 8

const sek = (amount: number) => formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })

function describeAccount(row: SIEAccountWithoutTarget): string {
  const where: string[] = []
  if (row.vouchers > 0) {
    where.push(`${row.vouchers} ${row.vouchers === 1 ? 'verifikation' : 'verifikationer'}, till exempel ${row.firstVoucher}`)
  }
  if (row.openingBalance !== 0) where.push(`ingående balans ${sek(row.openingBalance)}`)
  return `${row.account}${row.name ? ` ${row.name}` : ''} (${where.join('; ')})`
}

/** The Swedish refusal: which accounts, where their amounts are, and what to do. */
export function sieAmountsWithoutTargetSentence(rows: readonly SIEAccountWithoutTarget[]): string {
  const named = rows.slice(0, ACCOUNTS_NAMED).map(describeAccount).join(', ')
  const more = rows.length > ACCOUNTS_NAMED ? ` och ${rows.length - ACCOUNTS_NAMED} konton till` : ''
  const one = rows.length === 1
  return `${one ? 'Ett konto' : `${rows.length} konton`} med belopp i SIE-filen saknar målkonto: ${named}${more}. ` +
    'Utan målkonto kan beloppen varken bokföras eller stämmas av mot bokföringen. ' +
    `Välj målkonto för ${one ? 'kontot' : 'kontona'} i kontomappningen och starta importen igen.`
}
