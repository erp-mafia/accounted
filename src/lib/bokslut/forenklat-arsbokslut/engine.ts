import { equalOre, isZeroOre, roundOre, sumOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import {
  ASSET_POSTS,
  BALANSRAKNING_LAYOUT,
  RESULTATRAKNING_LAYOUT,
  type BalansPost,
  type K1LayoutRow,
  type K1Post,
  type K1Summa,
} from './bilaga2'
import {
  isResultAccount,
  isStatementAccount,
  k1ExclusionForAccount,
  k1PostForAccount,
  type K1ExclusionReason,
} from './account-mapping'
import type {
  K1Amounts,
  K1Check,
  K1Computation,
  K1PostAccount,
  K1StatementRow,
  K1TrialBalanceRow,
  K1YearBalances,
} from './types'

/**
 * The förenklat årsbokslut (BFNAR 2010:1) from trial balances: the
 * resultaträkning and balansräkning in the bilaga 2 layout with comparatives,
 * and the checks that decide whether the document may be made.
 *
 * Pure: the caller reads the books (lib/bokslut/forenklat-arsbokslut/service.ts)
 * and this turns two trial balances per year into the statements. The
 * resultaträkning reads the books before the resultatavslut, the
 * balansräkning after it, as the årsredovisning does.
 *
 * Blockers (the PDF is refused):
 *   - the year is not closed in the books;
 *   - an account outside every post carries a balance (another form's equity);
 *   - an avsättning is booked (BFNAR 2010:1 6.68);
 *   - the balansräkning does not balance;
 *   - årets över-/underskott differs from the closing account (2069).
 * Warnings: förutbetalda medlemsavgifter (6.73, 7.1), nettoomsättning above
 * 3 MSEK (BFL 6 kap. 3 §), and a comparison year that is missing, derived or
 * unbalanced.
 */

/** BFL 6 kap. 3 § andra stycket: nettoomsättning normally at most three million kronor. */
export const NETTOOMSATTNING_LIMIT = 3_000_000

/** BAS 2972 Förutbetalda medlemsavgifter: not a förskott under BFNAR 2010:1 6.73. */
export const PREPAID_MEMBER_FEES_ACCOUNT = '2972'

const NETTOOMSATTNING_POSTS: readonly K1Post[] = [
  'medlemsavgifter',
  'gavorOchBidrag',
  'ovrigaVerksamhetsintakter',
  'forsaljningsintakter',
]

export interface K1EngineInput {
  current: K1YearBalances
  /** The previous räkenskapsår's balances; null when there is none or it could not be read. */
  previous: K1YearBalances | null
  /** Set when a previous räkenskapsår exists but its balances could not be read. */
  previousUnavailable?: boolean
  /** Whether the räkenskapsår is closed in the books (fiscal_periods.is_closed). */
  isClosed: boolean
  /** The form's closing account (profile equity.closing, 2069): the balansräkning's årets över-/underskott. */
  closingAccount: string
}

interface NamedBalance {
  account_number: string
  account_name: string
  /** Debit minus credit. */
  balance: number
}

interface YearResult {
  posts: Record<K1Post, number>
  accounts: Map<K1Post, Map<string, { name: string; amount: number }>>
  excluded: Array<NamedBalance & { reason: K1ExclusionReason }>
  /** Årets över-/underskott by the resultaträkning (credit positive). */
  resultatResult: number
  /** Saldo on the closing account (credit positive). */
  closingBalance: number
  /** What is still on the result accounts in the full trial balance (credit positive); zero once closed. */
  unclosedResult: number
  /** The balansräkning's årets över-/underskott was taken from the result accounts, not the closing account. */
  derived: boolean
  prepaidMemberFees: number
}

function emptyPosts(): Record<K1Post, number> {
  const posts = {} as Record<K1Post, number>
  for (const row of [...RESULTATRAKNING_LAYOUT, ...BALANSRAKNING_LAYOUT]) {
    if (row.kind === 'post') posts[row.key] = 0
  }
  return posts
}

function balances(rows: readonly K1TrialBalanceRow[]): NamedBalance[] {
  return rows.map((row) => ({
    account_number: row.account_number,
    account_name: row.account_name,
    balance: roundOre((Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0)),
  }))
}

function addToPost(year: YearResult, post: K1Post, account: NamedBalance, amount: number): void {
  year.posts[post] = roundOre(year.posts[post] + amount)
  let perAccount = year.accounts.get(post)
  if (!perAccount) {
    perAccount = new Map()
    year.accounts.set(post, perAccount)
  }
  const existing = perAccount.get(account.account_number)
  perAccount.set(account.account_number, {
    name: account.account_name,
    amount: roundOre((existing?.amount ?? 0) + amount),
  })
}

function computeYear(balancesOfYear: K1YearBalances, closingAccount: string): YearResult {
  const year: YearResult = {
    posts: emptyPosts(),
    accounts: new Map(),
    excluded: [],
    resultatResult: 0,
    closingBalance: 0,
    unclosedResult: 0,
    derived: false,
    prepaidMemberFees: 0,
  }

  // Resultaträkning: the result accounts before the resultatavslut. An
  // income is credit (positive), a cost debit (negative).
  for (const account of balances(balancesOfYear.preClosing)) {
    if (!isResultAccount(account.account_number) || isZeroOre(account.balance)) continue
    const post = k1PostForAccount(account.account_number, account.balance)
    if (!post) {
      // 899x: årets resultat is the sum of the posts, never a post.
      continue
    }
    addToPost(year, post, account, -account.balance)
  }
  year.resultatResult = sumOre(
    RESULTATRAKNING_LAYOUT.flatMap((row) => (row.kind === 'post' ? [year.posts[row.key]] : [])),
  )

  // Balansräkning: classes 1-2 after the resultatavslut. Assets debit minus
  // credit; eget kapital, reserver and skulder credit minus debit.
  for (const account of balances(balancesOfYear.full)) {
    if (!isStatementAccount(account.account_number) || isZeroOre(account.balance)) continue
    if (isResultAccount(account.account_number)) {
      year.unclosedResult = roundOre(year.unclosedResult - account.balance)
      continue
    }
    if (account.account_number === closingAccount) {
      year.closingBalance = roundOre(year.closingBalance - account.balance)
      continue
    }
    if (account.account_number === PREPAID_MEMBER_FEES_ACCOUNT) {
      year.prepaidMemberFees = roundOre(year.prepaidMemberFees - account.balance)
    }
    const reason = k1ExclusionForAccount(account.account_number)
    if (reason) {
      year.excluded.push({ ...account, reason })
      continue
    }
    const post = k1PostForAccount(account.account_number, account.balance) as BalansPost | null
    if (!post) continue
    addToPost(year, post, account, ASSET_POSTS.has(post) ? account.balance : -account.balance)
  }

  // Årets över-/underskott. Once the year is closed, the result sits on the
  // closing account. A year never closed in these books (a comparison year
  // done in another system, or the current year before the wizard ran) still
  // carries it on the result accounts: that is the year's result, and what is
  // on the closing account was carried in from earlier years.
  if (isZeroOre(year.unclosedResult)) {
    year.posts.aretsOverUnderskott = year.closingBalance
    if (!isZeroOre(year.closingBalance)) {
      const perAccount = new Map([[closingAccount, { name: 'Årets resultat', amount: year.closingBalance }]])
      year.accounts.set('aretsOverUnderskott', perAccount)
    }
  } else {
    year.derived = true
    year.posts.aretsOverUnderskott = year.unclosedResult
    if (!isZeroOre(year.closingBalance)) {
      addToPost(
        year,
        'balanseradeOverUnderskott',
        { account_number: closingAccount, account_name: 'Årets resultat', balance: -year.closingBalance },
        year.closingBalance,
      )
    }
  }

  // A net skattefordran is not a skatteskuld: BFN example 5-1 step 10 puts it
  // under Övriga fordringar.
  if (year.posts.skatteskulder < 0) {
    const receivable = -year.posts.skatteskulder
    year.posts.ovrigaFordringar = roundOre(year.posts.ovrigaFordringar + receivable)
    year.posts.skatteskulder = 0
    const moved = year.accounts.get('skatteskulder')
    if (moved) {
      const target = year.accounts.get('ovrigaFordringar') ?? new Map()
      for (const [number, entry] of moved) {
        target.set(number, { name: entry.name, amount: roundOre((target.get(number)?.amount ?? 0) - entry.amount) })
      }
      year.accounts.set('ovrigaFordringar', target)
      year.accounts.delete('skatteskulder')
    }
  }

  return year
}

function summaValues(posts: Record<K1Post, number>): Record<K1Summa, number> {
  const values = {} as Record<K1Summa, number>
  for (const row of [...RESULTATRAKNING_LAYOUT, ...BALANSRAKNING_LAYOUT]) {
    if (row.kind !== 'summa') continue
    values[row.key] = sumOre(
      row.terms.map((term) => (term in values ? values[term as K1Summa] : posts[term as K1Post])),
    )
  }
  return values
}

function isPostKey(term: string): term is K1Post {
  return term in emptyPosts()
}

function buildRows(
  layout: readonly K1LayoutRow[],
  current: YearResult,
  previous: YearResult | null,
): K1StatementRow[] {
  const currentSums = summaValues(current.posts)
  const previousSums = previous ? summaValues(previous.posts) : null
  const shownPosts = new Set<string>()
  const shownSums = new Set<string>()

  for (const row of layout) {
    if (row.kind === 'post') {
      const hasCurrent = !isZeroOre(current.posts[row.key])
      const hasPrevious = previous !== null && !isZeroOre(previous.posts[row.key])
      if (hasCurrent || hasPrevious) shownPosts.add(row.key)
    } else if (row.kind === 'summa') {
      const postTerms = row.terms.filter(isPostKey)
      const sumTerms = row.terms.filter((term) => !isPostKey(term))
      // A summeringsrad that adds posts is printed when one of them is; one
      // that only repeats the line above it (no post of its own printed) is
      // left out, as BFN's example 5-2 does.
      const shown =
        row.always === true ||
        (postTerms.length > 0
          ? postTerms.some((term) => shownPosts.has(term))
          : sumTerms.some((term) => shownSums.has(term)))
      if (shown) shownSums.add(row.key)
    }
  }

  const rows: K1StatementRow[] = []
  layout.forEach((row, index) => {
    if (row.kind === 'rubrik') {
      // A rubrik is printed when a post under it is: the posts up to the next
      // rubrik or summeringsrad.
      let anyShown = false
      for (const next of layout.slice(index + 1)) {
        if (next.kind !== 'post') break
        if (shownPosts.has(next.key)) anyShown = true
      }
      if (anyShown) rows.push({ kind: 'rubrik', key: row.key, label: row.label, current: null, previous: null })
      return
    }
    if (row.kind === 'post') {
      if (!shownPosts.has(row.key)) return
      rows.push({
        kind: 'post',
        key: row.key,
        label: row.label,
        current: current.posts[row.key],
        previous: previous ? previous.posts[row.key] : null,
        accounts: accountsOf(row.key, current, previous),
      })
      return
    }
    if (!shownSums.has(row.key)) return
    rows.push({
      kind: 'summa',
      key: row.key,
      label: row.label,
      current: currentSums[row.key],
      previous: previousSums ? previousSums[row.key] : null,
    })
  })
  return rows
}

function accountsOf(post: K1Post, current: YearResult, previous: YearResult | null): K1PostAccount[] {
  const merged = new Map<string, K1PostAccount>()
  for (const [number, entry] of current.accounts.get(post) ?? []) {
    merged.set(number, { account_number: number, account_name: entry.name, current: entry.amount, previous: previous ? 0 : null })
  }
  if (previous) {
    for (const [number, entry] of previous.accounts.get(post) ?? []) {
      const existing = merged.get(number)
      if (existing) existing.previous = entry.amount
      else merged.set(number, { account_number: number, account_name: entry.name, current: 0, previous: entry.amount })
    }
  }
  return [...merged.values()].sort((a, b) => a.account_number.localeCompare(b.account_number))
}

/** "1 234,56 kr": an amount as a bookkeeper reads it in a message. */
function kr(amount: number): string {
  return formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })
}

function nameAccounts(accounts: readonly NamedBalance[]): string {
  return accounts
    .map((a) => `${a.account_number} ${a.account_name} (${kr(Math.abs(a.balance))} ${a.balance < 0 ? 'kredit' : 'debet'})`)
    .join(', ')
}

function amounts(current: number, previous: number | null): K1Amounts {
  return { current, previous }
}

function nettoomsattning(posts: Record<K1Post, number>): number {
  return sumOre(NETTOOMSATTNING_POSTS.map((post) => posts[post]))
}

export function computeForenklatArsbokslut(input: K1EngineInput): K1Computation {
  const current = computeYear(input.current, input.closingAccount)
  const previous = input.previous ? computeYear(input.previous, input.closingAccount) : null
  const currentSums = summaValues(current.posts)
  const previousSums = previous ? summaValues(previous.posts) : null

  const blockers: K1Check[] = []
  const warnings: K1Check[] = []

  if (!input.isClosed) {
    blockers.push({
      code: 'YEAR_NOT_CLOSED',
      message:
        'Räkenskapsåret är inte stängt. Gör bokslutet i bokslutsguiden först: det förenklade årsbokslutet upprättas av den avslutade bokföringen.',
    })
  }

  const avsattningar = current.excluded.filter((a) => a.reason === 'avsattning')
  if (avsattningar.length > 0) {
    blockers.push({
      code: 'AVSATTNING_BOOKED',
      message:
        `${avsattningar.length === 1 ? 'Konto' : 'Kontona'} ${nameAccounts(avsattningar)} är ` +
        `${avsattningar.length === 1 ? 'en avsättning' : 'avsättningar'}. En förening som upprättar förenklat årsbokslut ` +
        'får inte göra avsättningar (BFNAR 2010:1 punkt 6.68): boka om beloppet innan årsbokslutet upprättas.',
    })
  }

  const outside = current.excluded.filter((a) => a.reason === 'other_form_equity')
  if (outside.length > 0) {
    blockers.push({
      code: 'ACCOUNT_OUTSIDE_LAYOUT',
      message:
        `${outside.length === 1 ? 'Konto' : 'Kontona'} ${nameAccounts(outside)} hör till eget kapital i en annan ` +
        'företagsform och har ingen post i en ideell förenings förenklade årsbokslut. Boka om saldot till ' +
        'föreningens egna kapital (2060-2079).',
    })
  }

  const assets = currentSums.summaTillgangar
  const claims = currentSums.summaEgetKapitalOchSkulder
  if (!equalOre(assets, claims)) {
    blockers.push({
      code: 'BALANCE_SHEET_UNBALANCED',
      message: `Balansräkningen balanserar inte: summa tillgångar är ${kr(assets)} men summa eget kapital och skulder är ${kr(claims)}.`,
    })
  }

  if (input.isClosed && (current.derived || !equalOre(current.resultatResult, current.closingBalance))) {
    blockers.push({
      code: 'RESULT_DIFFERS_FROM_CLOSING_ACCOUNT',
      message:
        `Årets över-/underskott enligt resultaträkningen är ${kr(current.resultatResult)} men saldot på konto ` +
        `${input.closingAccount} Årets resultat är ${kr(current.closingBalance)}. ` +
        (current.derived
          ? `Resultatkontona har saldon kvar efter bokslutet (${kr(current.unclosedResult)}). `
          : 'Kontrollera att föregående års resultat har förts om från kontot vid årets ingång. ') +
        'Rätta bokföringen innan årsbokslutet upprättas.',
    })
  }

  if (!isZeroOre(current.prepaidMemberFees)) {
    warnings.push({
      code: 'PREPAID_MEMBER_FEES',
      message:
        `Konto ${PREPAID_MEMBER_FEES_ACCOUNT} Förutbetalda medlemsavgifter har ett saldo på ${kr(current.prepaidMemberFees)}. ` +
        'En medlemsavgift är intäkt när den betalas och är aldrig ett förskott (BFNAR 2010:1 punkterna 6.73 och 7.1). ' +
        'Kontrollera om beloppet ska redovisas som intäkt.',
    })
  }

  const omsattning = nettoomsattning(current.posts)
  const previousOmsattning = previous ? nettoomsattning(previous.posts) : null
  if (omsattning > NETTOOMSATTNING_LIMIT) {
    const bothYears = previousOmsattning !== null && previousOmsattning > NETTOOMSATTNING_LIMIT
    warnings.push({
      code: 'NETTOOMSATTNING_ABOVE_LIMIT',
      message:
        `Nettoomsättningen med medlemsavgifter, gåvor och bidrag är ${kr(omsattning)}, över tre miljoner kronor` +
        (bothYears ? ` även föregående år (${kr(previousOmsattning)})` : '') +
        '. Förenklat årsbokslut får upprättas när nettoomsättningen normalt är högst tre miljoner kronor ' +
        '(BFL 6 kap. 3 §); ' +
        (bothYears
          ? 'två år i rad över gränsen talar för att föreningen ska upprätta ett årsbokslut enligt BFL 6 kap. 4 §.'
          : 'ett enstaka år över gränsen kan gå, men inte flera år i rad.'),
    })
  }

  if (input.previousUnavailable) {
    warnings.push({
      code: 'COMPARATIVE_YEAR_UNAVAILABLE',
      message:
        'Föregående räkenskapsårs saldon kunde inte läsas, så jämförelsetal saknas. Jämförelsetal ska lämnas för varje post ' +
        'och summeringsrad (BFNAR 2010:1 punkt 5.2): kontrollera föregående års bokföring.',
    })
  }
  if (previous?.derived) {
    warnings.push({
      code: 'COMPARATIVE_YEAR_DERIVED',
      message:
        'Föregående räkenskapsår är inte avslutat i bokföringen: årets över-/underskott i jämförelsekolumnen är hämtat ' +
        'från resultatkontona. Stäm av jämförelsetalen mot föregående års fastställda årsbokslut.',
    })
  }
  if (previous && previousSums && !equalOre(previousSums.summaTillgangar, previousSums.summaEgetKapitalOchSkulder)) {
    warnings.push({
      code: 'COMPARATIVE_YEAR_UNBALANCED',
      message:
        `Jämförelsetalen i balansräkningen balanserar inte: summa tillgångar ${kr(previousSums.summaTillgangar)}, ` +
        `summa eget kapital och skulder ${kr(previousSums.summaEgetKapitalOchSkulder)}. Kontrollera föregående års bokföring.`,
    })
  }

  return {
    resultatrakning: buildRows(RESULTATRAKNING_LAYOUT, current, previous),
    balansrakning: buildRows(BALANSRAKNING_LAYOUT, current, previous),
    totals: {
      aretsOverUnderskott: amounts(currentSums.aretsOverUnderskottResultat, previousSums?.aretsOverUnderskottResultat ?? null),
      summaTillgangar: amounts(currentSums.summaTillgangar, previousSums?.summaTillgangar ?? null),
      summaEgetKapitalOchSkulder: amounts(
        currentSums.summaEgetKapitalOchSkulder,
        previousSums?.summaEgetKapitalOchSkulder ?? null,
      ),
      nettoomsattning: amounts(omsattning, previousOmsattning),
    },
    blockers,
    warnings,
  }
}
