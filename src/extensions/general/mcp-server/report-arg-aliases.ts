/**
 * Argument aliases for the read-only report tools.
 *
 * The report tools name the same idea differently (period_id vs the
 * fiscal_period_id agents guess; from_date on the income statement, date_from
 * on query_journal), and prod telemetry shows a steady stream of calls
 * rejected for exactly those names. For READ-ONLY report tools a known
 * synonym is mapped to the tool's own parameter before the unknown-argument
 * guard runs. Nothing changes in tools/list: schemas stay strict and only
 * advertise the canonical names.
 *
 * Deliberately narrow: only read-only report tools (a wrong guess can at
 * worst return the wrong report, never write), only explicit per-tool
 * mappings (no fuzzy matching), and an alias that collides with its
 * canonical key is refused rather than resolved, so an ambiguous call never
 * silently picks a side.
 *
 * Every other tool gets suggestArgKey instead: the unknown-parameter error
 * names the parameter the caller most likely meant.
 */

interface AliasRule {
  /** Canonical key(s) the alias value is written to. */
  to: readonly string[]
  /** Wrap a scalar value in an array (e.g. metric -> metrics). */
  wrapArray?: boolean
}

const PERIOD = { fiscal_period_id: { to: ['period_id'] } }

export const REPORT_ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, AliasRule>>>> = {
  gnubok_get_income_statement: {
    ...PERIOD,
    date_from: { to: ['from_date'] },
    start_date: { to: ['from_date'] },
    date_to: { to: ['to_date'] },
    end_date: { to: ['to_date'] },
    as_of_date: { to: ['to_date'] },
  },
  gnubok_get_balance_sheet: {
    ...PERIOD,
    as_of: { to: ['as_of_date'] },
    to_date: { to: ['as_of_date'] },
    date_to: { to: ['as_of_date'] },
    end_date: { to: ['as_of_date'] },
  },
  gnubok_get_trial_balance: {
    ...PERIOD,
  },
  gnubok_get_general_ledger: {
    ...PERIOD,
    account_number: { to: ['account_from', 'account_to'] },
  },
  gnubok_get_kpi_report: {
    ...PERIOD,
    date_from: { to: ['from_date'] },
    start_date: { to: ['from_date'] },
    date_to: { to: ['to_date'] },
    end_date: { to: ['to_date'] },
    as_of_date: { to: ['to_date'] },
    metric: { to: ['metrics'], wrapArray: true },
  },
  gnubok_query_journal: {
    from_date: { to: ['date_from'] },
    start_date: { to: ['date_from'] },
    to_date: { to: ['date_to'] },
    end_date: { to: ['date_to'] },
    query: { to: ['text'] },
    search: { to: ['text'] },
    search_text: { to: ['text'] },
    account_number: { to: ['accounts'], wrapArray: true },
    account: { to: ['accounts'], wrapArray: true },
    voucher_number: { to: ['voucher_number_from', 'voucher_number_to'] },
  },
}

export interface AliasNormalization {
  args: Record<string, unknown>
  /** alias -> canonical keys it was written to, for telemetry and tests. */
  applied: Array<{ alias: string; to: readonly string[] }>
  /** Aliases refused because the canonical key was also given. */
  conflicts: Array<{ alias: string; canonical: string }>
}

/**
 * Rewrite known aliases to the tool's canonical parameter names. Tools
 * without an alias table get their args back untouched.
 */
export function normalizeReportArgAliases(
  toolName: string,
  args: Record<string, unknown>,
): AliasNormalization {
  const table = REPORT_ARG_ALIASES[toolName]
  if (!table) return { args, applied: [], conflicts: [] }

  const out: Record<string, unknown> = { ...args }
  const applied: AliasNormalization['applied'] = []
  const conflicts: AliasNormalization['conflicts'] = []
  const written = new Set<string>()

  for (const [alias, rule] of Object.entries(table)) {
    if (!(alias in args)) continue
    const clash = rule.to.find((key) => key in args || written.has(key))
    if (clash) {
      conflicts.push({ alias, canonical: clash })
      continue
    }
    const raw = args[alias]
    const value = rule.wrapArray && !Array.isArray(raw) ? [raw] : raw
    for (const key of rule.to) {
      out[key] = value
      written.add(key)
    }
    delete out[alias]
    applied.push({ alias, to: rule.to })
  }
  return { args: out, applied, conflicts }
}

/** Common synonyms, each with the canonical names it most likely means. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  fiscal_period_id: ['period_id', 'fiscal_period_id'],
  fiscal_year_id: ['period_id', 'fiscal_period_id'],
  date_from: ['from_date', 'date_from'],
  from_date: ['date_from', 'from_date'],
  start_date: ['from_date', 'date_from', 'period_start'],
  date_to: ['to_date', 'date_to'],
  to_date: ['date_to', 'to_date', 'as_of_date'],
  end_date: ['to_date', 'date_to', 'period_end'],
  as_of: ['as_of_date', 'to_date'],
  as_of_date: ['to_date', 'date_to', 'as_of'],
  query: ['text', 'query', 'search'],
  search: ['query', 'text', 'search'],
  search_text: ['text', 'query'],
  account: ['account_number', 'accounts', 'account_from'],
  account_number: ['accounts', 'account_from', 'account'],
  metric: ['metrics'],
}

/**
 * The parameter an unknown key most likely meant, or null. Used to add a
 * "did you mean" hint to the unknown-parameter error on every tool.
 */
export function suggestArgKey(unknownKey: string, validKeys: readonly string[]): string | null {
  const candidates = SYNONYMS[unknownKey]
  if (!candidates) return null
  return candidates.find((key) => key !== unknownKey && validKeys.includes(key)) ?? null
}
