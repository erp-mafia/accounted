import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The SIE import invariant checks the weekly cron runs
 * (/api/import/sie/invariants/cron), each its own RPC call with its own
 * statement budget (migration 20261110094517). Until then one statement
 * grouped every imported voucher of every company and hit its 30 s statement
 * timeout, so the cron reported nothing at all.
 */

/**
 * Why a check could not run: the database error code (57014 is a statement
 * timeout) for the response, the message for the run log only.
 */
export interface CheckFailure {
  code: string | null
  message: string
}

export function checkFailure(err: unknown): CheckFailure {
  const shape = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; message?: unknown }
  return {
    code: typeof shape.code === 'string' && shape.code ? shape.code : null,
    message: typeof shape.message === 'string' ? shape.message : String(err),
  }
}

/** What check_sie_import_job_invariants returns: the import job and fiscal year hold checks. */
export interface SieImportJobInvariants {
  /** Unfinished import jobs whose fiscal year does not hold them. */
  missing_holds: number
  /** Fiscal years still held by a finished job. */
  stale_holds: number
  paused_jobs: number
  /** Unfinished jobs whose worker lease ran out more than 10 minutes ago. */
  expired_leases: number
  oldest_unresolved: string | null
}

export async function checkSieImportJobInvariants(supabase: SupabaseClient): Promise<SieImportJobInvariants> {
  const { data, error } = await supabase.rpc('check_sie_import_job_invariants')
  if (error) throw error
  const row = (data ?? {}) as Partial<Record<keyof SieImportJobInvariants, unknown>>
  return {
    missing_holds: Number(row.missing_holds ?? 0),
    stale_holds: Number(row.stale_holds ?? 0),
    paused_jobs: Number(row.paused_jobs ?? 0),
    expired_leases: Number(row.expired_leases ?? 0),
    oldest_unresolved: row.oldest_unresolved == null ? null : String(row.oldest_unresolved),
  }
}

/** How many companies one check_sie_import_duplicate_vouchers call checks. */
export const DUPLICATE_SCAN_COMPANY_PAGE = 500
/** The single-statement check sampled the first 20 groups; so does the scan. */
const DUPLICATE_SAMPLE_LIMIT = 20

/**
 * The duplicate imported voucher check over every company, page by page. A
 * copy group is two or more posted imported vouchers of one company and
 * fiscal year with the same source series, number and voucher date
 * (migration 20261116093917): a reused source number on another date is a
 * different voucher.
 */
export interface SieDuplicateVoucherScan {
  /**
   * Copy groups that hold a voucher with an import batch: the copies the
   * import engine can still make, and the violation the cron reports.
   */
  duplicate_groups: number
  /** Vouchers beyond the first of each of those groups. */
  extra_vouchers: number
  /** The first 20 of those groups in company, fiscal year, series, number and date order. */
  duplicate_samples: unknown[]
  /**
   * Copy groups made only of vouchers imported before imports had a batch
   * identity (#2532). No such voucher can be posted any more, so these are
   * known history: reported, never alerted.
   */
  legacy_duplicate_groups: number
  /** Vouchers beyond the first of each legacy group. */
  legacy_extra_vouchers: number
  /** Companies checked, in company id order. */
  companies_checked: number
  /** The last company checked; null before the first page finished. */
  last_company_id: string | null
  /** True when every company was checked. */
  finished: boolean
  /** Why the scan stopped before the last company. */
  stopped: 'run_budget' | 'page_failed' | 'no_progress' | null
  /** The failed page's error, when stopped is page_failed. */
  failure: CheckFailure | null
}

interface DuplicatePage {
  companies_checked?: unknown
  last_company_id?: unknown
  done?: unknown
  duplicate_groups?: unknown
  extra_vouchers?: unknown
  duplicate_samples?: unknown
  legacy_duplicate_groups?: unknown
  legacy_extra_vouchers?: unknown
}

/**
 * Walks check_sie_import_duplicate_vouchers over the companies in id order
 * until the last one, a failed page, or the deadline: no page starts after
 * it, and a started page ends within its statement timeout. A group never
 * spans companies, so the summed pages count exactly what one statement over
 * all companies would, and a scan that stops early reports how far it got
 * instead of nothing.
 */
export async function scanSieImportDuplicateVouchers(
  supabase: SupabaseClient,
  options: { deadline: number; companyPageSize?: number; now?: () => number },
): Promise<SieDuplicateVoucherScan> {
  const now = options.now ?? Date.now
  const pageSize = options.companyPageSize ?? DUPLICATE_SCAN_COMPANY_PAGE
  const scan: SieDuplicateVoucherScan = {
    duplicate_groups: 0,
    extra_vouchers: 0,
    duplicate_samples: [],
    legacy_duplicate_groups: 0,
    legacy_extra_vouchers: 0,
    companies_checked: 0,
    last_company_id: null,
    finished: false,
    stopped: null,
    failure: null,
  }

  for (;;) {
    if (now() >= options.deadline) {
      scan.stopped = 'run_budget'
      return scan
    }
    const { data, error } = await supabase.rpc('check_sie_import_duplicate_vouchers', {
      p_after_company_id: scan.last_company_id,
      p_company_limit: pageSize,
    })
    if (error) {
      scan.stopped = 'page_failed'
      scan.failure = checkFailure(error)
      return scan
    }
    const page = (data ?? {}) as DuplicatePage
    const checked = Number(page.companies_checked ?? 0)
    scan.duplicate_groups += Number(page.duplicate_groups ?? 0)
    scan.extra_vouchers += Number(page.extra_vouchers ?? 0)
    scan.legacy_duplicate_groups += Number(page.legacy_duplicate_groups ?? 0)
    scan.legacy_extra_vouchers += Number(page.legacy_extra_vouchers ?? 0)
    scan.companies_checked += checked
    if (Array.isArray(page.duplicate_samples)) {
      const room = DUPLICATE_SAMPLE_LIMIT - scan.duplicate_samples.length
      if (room > 0) scan.duplicate_samples.push(...page.duplicate_samples.slice(0, room))
    }
    const last = typeof page.last_company_id === 'string' ? page.last_company_id : null
    const advanced = checked > 0 && last !== null && last !== scan.last_company_id
    if (advanced) scan.last_company_id = last
    if (page.done === true) {
      scan.finished = true
      return scan
    }
    if (!advanced) {
      // A page that is not the last must move on; never ask for it again.
      scan.stopped = 'no_progress'
      return scan
    }
  }
}
