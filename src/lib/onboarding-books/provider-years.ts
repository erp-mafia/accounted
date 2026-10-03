/**
 * The books act imports a provider's fiscal years one SIE file at a time
 * (ProviderStep), oldest first. A retry after a failed year used to send
 * every file again from the oldest. A year that had already landed was then
 * refused by start_sie_import_job (the period already holds an import, or,
 * for the same file with a different mapping, 'SIE retry has different
 * mapping or options'), so the run died before it reached the year that was
 * actually missing.
 *
 * Here a year that a completed import already holds is skipped: /sie-data
 * marks it with `previousImport` (a completed sie_imports row overlapping
 * that fiscal year, see findOverlappingPeriodImports). The run stops at the
 * first year that fails, and the outcome names every selected year that is
 * not in the books, so the step can say which and keep the door onward
 * closed until they are.
 */

/** One fetched file's status as /sie-data answers it, index-aligned with rawContent. */
export interface ProviderFileStatus {
  fiscalYear: number
  /** A completed import already covers this fiscal year. */
  previousImport?: { id: string } | null
}

export interface ProviderYearsInput {
  /** One SIE 4 file per fetched year, oldest first. */
  rawContent: string[]
  /** Absent from an older server: then every file is imported, as before. */
  fileStatuses?: ProviderFileStatus[]
  /** Selected years the provider did not hand over. */
  failedYears?: { year: number }[]
}

export interface ProviderYearPlan {
  /** Files still to import, by index into rawContent, in the server's order. */
  pending: { index: number; fiscalYear: number | null }[]
  /** Years a completed import already holds: not sent again. */
  alreadyImported: number[]
}

export interface ProviderYearsOutcome {
  /** Years this run imported. */
  imported: number[]
  /** Years a completed import already held, skipped. */
  alreadyImported: number[]
  /** The year that stopped the run and why; fiscalYear is null when the server named none. */
  failed: { fiscalYear: number | null; reason: string } | null
  /** Years after the failed one, never attempted. */
  notReached: number[]
  /** Selected years the provider did not hand over. */
  notFetched: number[]
}

/** What one file's import answered; the step's SieImportOutcome satisfies it. */
export interface ProviderYearResult {
  success: boolean
  errors: string[]
}

export function planProviderYears(input: ProviderYearsInput): ProviderYearPlan {
  const pending: ProviderYearPlan['pending'] = []
  const alreadyImported: number[] = []
  input.rawContent.forEach((_, index) => {
    const status = input.fileStatuses?.[index]
    if (status?.previousImport) alreadyImported.push(status.fiscalYear)
    else pending.push({ index, fiscalYear: status?.fiscalYear ?? null })
  })
  return { pending, alreadyImported }
}

/** #VER records in one SIE file, counted the way the parser's diagnostic counts them. */
export function countSieVouchers(rawContent: string): number {
  return rawContent.match(/^[ \t]*#VER\b/gm)?.length ?? 0
}

/**
 * Import the files the plan leaves, in order, and stop at the first one that
 * fails. `importOne` either answers with the import's result or throws;
 * `reasonOf` turns a thrown error into the sentence the user reads.
 * `shouldStop` is asked before each year starts: once the user has left the
 * act (lib/onboarding-books/skip), the year already running finishes on the
 * server and the later ones are not started, only named as not reached.
 */
export async function importProviderYears(
  input: ProviderYearsInput,
  importOne: (rawContent: string) => Promise<ProviderYearResult>,
  reasonOf: (err: unknown) => string,
  shouldStop: () => boolean = () => false,
): Promise<ProviderYearsOutcome> {
  const plan = planProviderYears(input)
  const imported: number[] = []
  let failed: ProviderYearsOutcome['failed'] = null
  // Index of the first pending year this run did not attempt.
  let notReachedFrom = plan.pending.length
  for (let i = 0; i < plan.pending.length; i++) {
    if (shouldStop()) {
      notReachedFrom = i
      break
    }
    const { index, fiscalYear } = plan.pending[i]
    let reason: string | null
    try {
      const result = await importOne(input.rawContent[index])
      reason = result.success ? null : result.errors.join(' ')
    } catch (err) {
      reason = reasonOf(err)
    }
    if (reason !== null) {
      failed = { fiscalYear, reason }
      notReachedFrom = i + 1
      break
    }
    if (fiscalYear !== null) imported.push(fiscalYear)
  }
  const notReached = plan.pending
    .slice(notReachedFrom)
    .flatMap((f) => (f.fiscalYear !== null ? [f.fiscalYear] : []))
  const notFetched = (input.failedYears ?? []).map((f) => f.year)
  return { imported, alreadyImported: plan.alreadyImported, failed, notReached, notFetched }
}

/** Every selected year is in the books: the only state that may lead onward. */
export function providerYearsComplete(outcome: ProviderYearsOutcome): boolean {
  return outcome.failed === null && outcome.notReached.length === 0 && outcome.notFetched.length === 0
}
