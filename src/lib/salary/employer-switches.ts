/**
 * The three employer switches on the Lön settings page: what they show and
 * what a save sends (crm#1790).
 *
 * employer_registered is NULL until someone answers it, and NULL is a state of
 * its own. The AGI deadline rows (isAgiEmployer in lib/tax/deadline-config)
 * derive an unanswered flag from pays_salaries and the employees, and a booked
 * salary run fills it (20260904191000, COALESCE). A stored false is the
 * person's own answer: it turns the AGI rows off and the booked run leaves it.
 * A switch can only show on or off, so a save that wrote the shown value would
 * turn an unanswered NULL into that answer without anyone giving it. The save
 * therefore sends employer_registered only when the person set the switch on
 * this page (directly, or by turning pays salaries on); untouched, the stored
 * value is left as it is, NULL included.
 */

/** The stored flags, as company_settings holds them. */
export interface StoredEmployerFlags {
  pays_salaries?: boolean | null
  employer_registered?: boolean | null
  employer_seasonal?: boolean | null
}

/** What the person set on the page; null = not touched, read the stored value. */
export interface EmployerSwitchEdits {
  paysSalaries: boolean | null
  employerRegistered: boolean | null
  employerSeasonal: boolean | null
}

/** The fields a save of the page sends to PUT /api/settings. */
export interface EmployerSwitchUpdates {
  pays_salaries: boolean
  /** Absent when the switch was not touched: the stored value stays. */
  employer_registered?: boolean
  employer_seasonal: boolean
}

export interface EmployerSwitches {
  paysSalaries: boolean
  employerRegistered: boolean
  employerSeasonal: boolean
  updates: EmployerSwitchUpdates
}

export function resolveEmployerSwitches(
  stored: StoredEmployerFlags,
  edits: EmployerSwitchEdits,
): EmployerSwitches {
  const paysSalaries = edits.paysSalaries ?? stored.pays_salaries ?? false
  // Never answered, the switch shows pays salaries as it stands on the page,
  // the value the deadlines read first for an unanswered flag. It follows that
  // switch until the person sets this one, so it never shows a value the save
  // would not keep.
  const employerRegistered = edits.employerRegistered ?? stored.employer_registered ?? paysSalaries
  const employerSeasonal = edits.employerSeasonal ?? stored.employer_seasonal ?? false

  const updates: EmployerSwitchUpdates = {
    pays_salaries: paysSalaries,
    // Seasonal registration is a mode of being a registered employer.
    employer_seasonal: employerRegistered && employerSeasonal,
  }
  if (edits.employerRegistered !== null) updates.employer_registered = edits.employerRegistered

  return { paysSalaries, employerRegistered, employerSeasonal, updates }
}
