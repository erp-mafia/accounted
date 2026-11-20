/**
 * Preflight for the K3 iXBRL document, on top of the rules every document
 * gets (rules.ts). Accounted's own checks (ACC-K3-*): the K3 forms have no
 * calculation linkbases, so Bolagsverket's kontrollera cannot be relied on
 * to catch a specification that does not add up.
 *
 *   - The specification of changes in equity ties: per post, opening plus
 *     movements equals closing, and the closings add up to the balance
 *     sheet's eget kapital (ÅRL 6 kap. 2 §, K3 6.3); the openings to last
 *     year's.
 *   - The kassaflödesanalys ties: likvida medel at the start, plus årets
 *     kassaflöde and the kursdifferens, equals likvida medel at the end; the
 *     comparative year's closing equals this year's opening (the two are the
 *     same fact, LikvidaMedel at the same date). Each section's lines add up
 *     to its subtotal and total, the three totals to årets kassaflöde, and
 *     the result line it starts from is the RR's (the document tags the RR
 *     figure there, so a different figure would leave the column unbalanced).
 *   - Required facts: a redovisningsprinciper note (K3 8.3) and a
 *     medelantal anställda note (ÅRL 5 kap. 20 §).
 *   - The sources are the real ones: an equity specification from the
 *     ledger, a chapter 7 kassaflödesanalys, K3's own balance sheet posts.
 *     A fallback built from closing balances or from the K2 mapping can be
 *     previewed, never filed.
 */

import { K3_CASH_FLOW_RESULT_LINES } from '../k3-adapters'
import type { IxbrlArsredovisningInput, K3CashFlowInput, K3CashFlowRow } from '../types'
import type { PreflightIssue } from './rules'

const issue = (code: string, severity: 'error' | 'warn', message: string): PreflightIssue => ({ code, severity, message })

const kr = (amount: number) => `${amount.toLocaleString('sv-SE')} kr`

const YEAR_LABEL = { current: 'räkenskapsåret', previous: 'jämförelseåret' } as const

/**
 * The statement's arithmetic, per year: within each operating, investing
 * and financing section the lines add up to the subtotal and the total
 * (a subtotal carries on into the lines after it), and the three totals
 * add up to årets kassaflöde.
 */
function cashFlowSumIssues(cashFlow: K3CashFlowInput, field: 'current' | 'previous'): PreflightIssue[] {
  const issues: PreflightIssue[] = []
  const sectionTotals: number[] = []
  let running = 0
  for (const row of cashFlow.rows) {
    if (row.section === 'likvida_medel') continue
    const amount = row[field] ?? 0
    if (row.kind === 'line') {
      running += amount
      continue
    }
    if (running !== amount) {
      issues.push(
        issue(
          'ACC-K3-KFA-SUM',
          'error',
          `Kassaflödesanalysen (${YEAR_LABEL[field]}): raderna ovanför "${row.label}" summerar till ${kr(running)}, inte ${kr(amount)}.`,
        ),
      )
    }
    if (row.kind === 'total') {
      sectionTotals.push(amount)
      running = 0
    } else {
      running = amount
    }
  }
  const aretsKassaflode = cashFlow.rows.find((row) => row.key === 'arets_kassaflode')
  const sum = sectionTotals.reduce((total, amount) => total + amount, 0)
  if (aretsKassaflode && (aretsKassaflode[field] ?? 0) !== sum) {
    issues.push(
      issue(
        'ACC-K3-KFA-SUM',
        'error',
        `Kassaflödesanalysen (${YEAR_LABEL[field]}): årets kassaflöde ${kr(aretsKassaflode[field] ?? 0)} är inte summan av den löpande verksamheten, investeringsverksamheten och finansieringsverksamheten (${kr(sum)}).`,
      ),
    )
  }
  return issues
}

export function runK3PreflightChecks(input: IxbrlArsredovisningInput): PreflightIssue[] {
  const k3 = input.k3
  if (!k3) return []
  const issues: PreflightIssue[] = []

  if (k3.balanceSheetSource !== 'k3_presentation') {
    issues.push(
      issue(
        'ACC-K3-POSTS-SOURCE',
        'error',
        'K3:s egna balansräkningsposter (uppskjuten skatt, aktuell skattefordran, balanserade utvecklingsutgifter, fond för utvecklingsutgifter, fond för verkligt värde) redovisas ännu inte som egna poster i iXBRL-underlaget.',
      ),
    )
  }

  // ---- equity specification ----
  const equity = k3.equity
  if (equity.source !== 'ledger') {
    issues.push(
      issue(
        'ACC-K3-EQUITY-SOURCE',
        'error',
        'Förändringarna i eget kapital är härledda ur utgående balanser, inte ur årets bokföring: de kan förhandsgranskas men inte lämnas in.',
      ),
    )
  }
  const years: Array<{ field: 'current' | 'previous'; posts: typeof equity.posts }> = [{ field: 'current', posts: equity.posts }]
  // The jämförelseår is shown (and so checked) only in a statement of its own.
  if (equity.placement === 'separate_statement' && equity.previous && input.previousPeriod) {
    years.push({ field: 'previous', posts: equity.previous })
  }
  for (const { field, posts } of years) {
    const year = field === 'current' ? '' : ' (jämförelseåret)'
    for (const post of posts) {
      const moved = Object.values(post.movements).reduce((sum, amount) => sum + amount, 0)
      if (post.opening + moved !== post.closing) {
        issues.push(
          issue(
            'ACC-K3-EQUITY-TIE',
            'error',
            `${post.label}${year}: ingående ${kr(post.opening)} och årets förändringar ${kr(moved)} ger inte utgående ${kr(post.closing)}.`,
          ),
        )
      }
      const balanceSheet = input.br[post.concept]?.[field] ?? 0
      if (balanceSheet !== post.closing) {
        issues.push(
          issue(
            'ACC-K3-EQUITY-TIE',
            'error',
            `${post.label}${year}: utgående ${kr(post.closing)} i förändringarna av eget kapital stämmer inte med balansräkningens ${kr(balanceSheet)}.`,
          ),
        )
      }
    }
  }
  if (equity.placement === 'separate_statement' && input.previousPeriod && !equity.previous) {
    issues.push(
      issue(
        'ACC-K3-EQUITY-PREVIOUS',
        'error',
        'Förändringen av eget kapital redovisas som egen rapport men jämförelseårets förändringar saknas: välj placering i förvaltningsberättelsen eller ta fram jämförelseårets specifikation.',
      ),
    )
  }
  const closing = equity.posts.reduce((sum, post) => sum + post.closing, 0)
  if (closing !== input.totals.egetKapital.current) {
    issues.push(
      issue(
        'ACC-K3-EQUITY-TOTAL',
        'error',
        `Förändringarna i eget kapital slutar på ${kr(closing)} men balansräkningens eget kapital är ${kr(input.totals.egetKapital.current)}.`,
      ),
    )
  }
  const previousEquity = input.totals.egetKapital.previous
  if (previousEquity !== null && input.previousPeriod) {
    const opening = equity.posts.reduce((sum, post) => sum + post.opening, 0)
    if (opening !== previousEquity) {
      issues.push(
        issue(
          'ACC-K3-EQUITY-TOTAL',
          'error',
          `Förändringarna i eget kapital börjar på ${kr(opening)} men föregående års eget kapital är ${kr(previousEquity)}.`,
        ),
      )
    }
  }

  // ---- kassaflödesanalys ----
  const cashFlow = k3.cashFlow
  if (cashFlow) {
    if (cashFlow.source !== 'chapter7') {
      issues.push(
        issue(
          'ACC-K3-KFA-SOURCE',
          'error',
          'Kassaflödesanalysen följer ännu inte K3 kapitel 7 (bruttoredovisade investerings- och finansieringsflöden, räntor och utdelningar för sig): lämna den utanför årsredovisningen eller vänta på K3-uppställningen.',
        ),
      )
    }
    if (!cashFlow.reconciled) {
      issues.push(
        issue('ACC-K3-KFA-TIE', 'error', 'Kassaflödesanalysens kassaflöde stämmer inte med förändringen av likvida medel.'),
      )
    }
    const byKey = new Map<string, K3CashFlowRow>(cashFlow.rows.map((row) => [row.key, row]))
    const amount = (key: string, field: 'current' | 'previous') => byKey.get(key)?.[field] ?? 0
    for (const field of ['current', 'previous'] as const) {
      if (field === 'previous' && (byKey.get('likvida_medel_ub')?.previous ?? null) === null) continue
      const expected = amount('likvida_medel_ib', field) + amount('arets_kassaflode', field) + amount('kursdifferens_likvida_medel', field)
      const actual = amount('likvida_medel_ub', field)
      if (expected !== actual) {
        issues.push(
          issue(
            'ACC-K3-KFA-TIE',
            'error',
            `Kassaflödesanalysen (${field === 'current' ? 'räkenskapsåret' : 'jämförelseåret'}): likvida medel vid årets början ${kr(amount('likvida_medel_ib', field))} plus årets kassaflöde ger inte likvida medel vid årets slut ${kr(actual)}.`,
          ),
        )
      }
    }
    const hasPrevious = (byKey.get('likvida_medel_ub')?.previous ?? null) !== null
    for (const field of hasPrevious ? (['current', 'previous'] as const) : (['current'] as const)) {
      issues.push(...cashFlowSumIssues(cashFlow, field))
      for (const row of cashFlow.rows) {
        const total = row.concept ? K3_CASH_FLOW_RESULT_LINES[row.concept as keyof typeof K3_CASH_FLOW_RESULT_LINES] : undefined
        const rr = total ? input.totals[total][field] : null
        if (total && rr !== null && row[field] !== rr) {
          issues.push(
            issue(
              'ACC-K3-KFA-RESULT',
              'error',
              `Kassaflödesanalysen (${YEAR_LABEL[field]}) utgår från ${row.label.toLowerCase()} ${kr(row[field] ?? 0)}, men resultaträkningen visar ${kr(rr)}.`,
            ),
          )
        }
      }
    }
    const previousClosing = byKey.get('likvida_medel_ub')?.previous ?? null
    if (previousClosing !== null && previousClosing !== amount('likvida_medel_ib', 'current')) {
      issues.push(
        issue(
          'ACC-K3-KFA-TIE',
          'error',
          `Likvida medel vid jämförelseårets slut (${kr(previousClosing)}) skiljer sig från likvida medel vid årets början (${kr(amount('likvida_medel_ib', 'current'))}).`,
        ),
      )
    }
  }

  // ---- required notes ----
  if (!input.noter.some((note) => /redovisnings.*principer/i.test(note.title))) {
    issues.push(issue('ACC-K3-PRINCIPLES', 'error', 'Noten om redovisnings- och värderingsprinciper saknas (K3 punkt 8.3).'))
  }
  if (!input.noter.some((note) => /medelantal.*anst/i.test(note.title))) {
    issues.push(issue('ACC-K3-MEDELANTAL', 'error', 'Noten om medelantalet anställda saknas (ÅRL 5 kap. 20 §).'))
  }
  return issues
}
