/**
 * SALARY_EXTRA_RUNS_COMPANY_IDS: several ordinary salary runs in one month,
 * for a company that pays groups of employees on different days (hourly
 * staff early in the month, monthly staff on the 26th). Unset = nobody:
 * every company keeps one live run per period until the operators list it.
 *
 * It rolls out per company, like BOOKING_SCREEN_COMPANY_IDS: `*` opens it
 * for every company, a comma-separated list of company ids for those only.
 *
 * What a listed company gets: an extra run beside a period's run
 * (salary_runs.run_number 2 and up), each employee on at most one run per
 * payout month and per period, one arbetsgivardeklaration for the payout
 * month summed over all its runs, and a booking text that tells the runs
 * apart. The same person on several runs of one month (weekly pay) is not
 * part of it: it is refused.
 *
 * What the switch never changes: a run already created. Switching a company
 * off again keeps its extra runs; a month that still has several runs is
 * then declared as before the switch, refused with AGI_PERIOD_CONFLICT.
 */
type Env = Record<string, string | undefined>

export type SalaryExtraRunsRollout = 'all' | readonly string[]

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function salaryExtraRunsRollout(env: Env = process.env): SalaryExtraRunsRollout {
  const raw = env.SALARY_EXTRA_RUNS_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether several salary runs in one month are switched on for this company. */
export function isSalaryExtraRunsEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = salaryExtraRunsRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}
