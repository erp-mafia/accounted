/**
 * A fiscal year an SIE import, or the undo of one, still holds
 * (fiscal_periods.import_hold) is not locked or closed. One refusal for every
 * path that would: lockPeriod, closePeriod and klarmarkera in
 * period-service.ts, the year-end readiness check, and MCP staging.
 */
import { userFacing } from '@/lib/errors/user-facing'

/** Structured code for locking or closing a year an SIE import still holds. */
export const PERIOD_HAS_UNFINISHED_SIE_IMPORT = 'PERIOD_HAS_UNFINISHED_SIE_IMPORT'

const SIE_HOLD_WORDING = {
  lock: { refused: 'låsas', retry: 'Lås året' },
  close: { refused: 'stängas', retry: 'Stäng året' },
  mark_closed: { refused: 'markeras som avslutat', retry: 'Markera året som avslutat' },
  year_end: { refused: 'stängas med bokslut', retry: 'Gör bokslutet' },
} as const

export type SieHoldAction = keyof typeof SIE_HOLD_WORDING

/** The Swedish refusal: which year, why, and the buttons that get it going. */
export function unfinishedSieImportMessage(periodName: string, action: SieHoldAction): string {
  const wording = SIE_HOLD_WORDING[action]
  return (
    `Räkenskapsåret ${periodName} kan inte ${wording.refused} medan en SIE-import för året inte är klar. ` +
    'Öppna importen via Visa import överst på sidan och tryck Fortsätt, eller Ångra import om du vill börja om. ' +
    `${wording.retry} när importen är klar eller ångrad.`
  )
}

function unfinishedSieImportError(
  periodName: string,
  action: SieHoldAction,
  importId: string | null,
): Error {
  const error = Object.assign(
    new Error(unfinishedSieImportMessage(periodName, action)),
    {
      code: PERIOD_HAS_UNFINISHED_SIE_IMPORT,
      remediation: {
        description:
          'An SIE import, or the undo of one, still holds this fiscal year (fiscal_periods.import_hold). Read its state with gnubok_sie_import_status; resuming or undoing it is the user\'s decision. Retry once it is completed or undone. Never lock first: a lock stops the import\'s own writes.',
        tool: 'gnubok_sie_import_status',
        ...(importId ? { args: { import_id: importId } } : {}),
      },
    },
  )
  return userFacing(error, PERIOD_HAS_UNFINISHED_SIE_IMPORT)
}

/**
 * Refuse to lock or close a fiscal year that an SIE import, or the undo of
 * one, still holds (fiscal_periods.import_hold, set when the run starts and
 * cleared when it is completed, undone or failed).
 *
 * The database already refuses the transition (guard_sie_period_hold,
 * migration 20260911171453), but in English and without a code, so the user
 * got "Något gick fel" and an agent its approval failing as UNKNOWN_ERROR.
 * This is the same predicate, read from the row the caller already has, so
 * the refusal names the year and the way out before anything is written,
 * and MCP staging can refuse with it too. Lock after the import, never
 * before: a lock stops the run's own writes, and resume and undo both
 * refuse a locked year until it is unlocked again (crm#1029).
 */
export function assertNoUnfinishedSieImport(
  period: { name: string; import_hold?: string | null },
  action: SieHoldAction,
): void {
  if (period.import_hold) throw unfinishedSieImportError(period.name, action, period.import_hold)
}

/**
 * The database guard's own refusal, for a run that took the hold between the
 * caller's read and its update: answered exactly like the pre-check.
 */
export function sieHoldRefusal(
  error: { message?: string } | null,
  periodName: string,
  action: SieHoldAction,
): Error | null {
  if (!error?.message || !/SIE import is unfinished/i.test(error.message)) return null
  return unfinishedSieImportError(periodName, action, null)
}
