/**
 * "Gör till rutin": a flow or an analysis run on a schedule by the user's own
 * Claude. Claude schedules recurring Cowork tasks that run in its cloud with
 * the user's connectors, even when the computer is off, on the paid plans
 * (support.claude.com, "Schedule recurring tasks in Claude Cowork"). They can
 * be created on claude.ai and in Claude Desktop. Accounted only writes the
 * request; Claude asks the user to confirm the schedule.
 *
 * Two ways in: Claude on the web (the request is copied and
 * claude.ai/cowork/new opened, which drops a ?q=) and Claude Desktop
 * (claude://cowork/new?q= fills the request in).
 */
export type RoutineCadence = 'daily' | 'weekdays' | 'weekly'
export const ROUTINE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type RoutineDay = (typeof ROUTINE_DAYS)[number]

/** Where the request goes: Claude on the web, or Claude Desktop. */
export type RoutineTarget = 'web' | 'desktop'

/**
 * What happened when the request was sent, for the status line: copied and
 * claude.ai opened, opened but the copy failed, or handed to Claude Desktop.
 */
export type RoutineSent = 'web' | 'web_uncopied' | 'desktop'
const SENT: readonly RoutineSent[] = ['web', 'web_uncopied', 'desktop']

/** Cowork's composer takes about 14 000 characters; a request is far shorter, but never send more. */
const MAX_PROMPT = 14000

/** Claude on the web, Cowork preselected. A ?q= is dropped here, so the request is copied instead. */
export const COWORK_WEB = 'https://claude.ai/cowork/new'

/**
 * The flows tied to a period (a month, a VAT period). Claude's schedules have
 * no monthly cadence, so a weekly run must first check whether the period is
 * already done: their routines use their own run text (routine_say.<id>).
 */
export const PERIOD_FLOWS = ['month-end-close', 'quarterly-vat-review'] as const

export function isPeriodFlow(id: string): id is (typeof PERIOD_FLOWS)[number] {
  return (PERIOD_FLOWS as readonly string[]).includes(id)
}

/** The page's translator (skills_registry), passed in so the request can be pinned in tests. */
export type RoutineTranslate = (key: string, values?: Record<string, string>) => string

export interface RoutineChoice { cadence: RoutineCadence; day: RoutineDay; time: string }

export interface RoutineRequest {
  choice: RoutineChoice
  /** The page's own start prompt: what one run does. */
  run: string
  /** An analysis only reads: its routine changes nothing and stages no proposals. */
  readOnly: boolean
  /**
   * The company the routine is for. Pinned in the request so a connection
   * that reaches several companies runs on these books, not the key's default.
   */
  company: { id: string; name: string }
}

/** "varje måndag kl 07:00 svensk tid": when the routine runs, in the page's language. */
export function routineWhen({ cadence, day, time }: RoutineChoice, t: RoutineTranslate): string {
  const at = routineTime(time)
  return cadence === 'weekly'
    ? t('routine_when_weekly', { day: t(`routine_days.${day}`), time: at })
    : t(`routine_when_${cadence}`, { time: at })
}

/**
 * The request Claude gets: schedule `run` for the company at the chosen time.
 * Nobody is there while it runs, so it runs unattended, never approves its
 * own proposals (an analysis proposes nothing at all), and runs once at once
 * while the user is there to allow Accounted's tools.
 */
export function routinePrompt({ choice, run, readOnly, company }: RoutineRequest, t: RoutineTranslate): string {
  const text = t(readOnly ? 'routine_prompt_analysis' : 'routine_prompt', {
    when: routineWhen(choice, t),
    company: t('routine_company', { name: company.name, id: company.id }),
    run,
  })
  return text.slice(0, MAX_PROMPT)
}

/** The request in one plain sentence for the page; the exact text sits behind "Visa exakt text". */
export function routineSummary({ choice, readOnly, company }: Omit<RoutineRequest, 'run'>, name: string, t: RoutineTranslate): string {
  return t(readOnly ? 'routine_summary_analysis' : 'routine_summary', { name, company: company.name, when: routineWhen(choice, t) })
}

/**
 * The link that opens Claude Desktop in a new Cowork task with the request
 * filled in. A claude:// link is a local handoff to the app, with no HTTP
 * request and no URL log, like a paste: it may carry the user's own text and
 * the company (founder decision). An https ?q= link never does.
 */
export function coworkLink(prompt: string): string {
  return `claude://cowork/new?q=${encodeURIComponent(prompt)}`
}

/** A time the time input can hold: HH:MM, else the fallback (the last valid time, or 07:00). */
export function routineTime(value: string, fallback = '07:00'): string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback
}

const CADENCES: readonly RoutineCadence[] = ['daily', 'weekdays', 'weekly']

/**
 * A routine chosen while writing an item, handed to the item's page in the
 * URL (?rutin=weekly&dag=mon&tid=07:00) so its "Gör till rutin" panel opens
 * filled in. When saving already sent it, `sent` rides along (&skickad=web)
 * so the panel says what to do in Claude and offers to send it again: a
 * Desktop that never opened must not lose the routine.
 */
export function routineQuery(choice: RoutineChoice, sent?: RoutineSent | null): string {
  const params = new URLSearchParams({ rutin: choice.cadence, dag: choice.day, tid: routineTime(choice.time) })
  if (sent) params.set('skickad', sent)
  return params.toString()
}

export function parseRoutineQuery(params: URLSearchParams): RoutineChoice | null {
  const cadence = params.get('rutin') as RoutineCadence | null
  if (!cadence || !CADENCES.includes(cadence)) return null
  const day = params.get('dag') as RoutineDay | null
  return { cadence, day: day && ROUTINE_DAYS.includes(day) ? day : 'mon', time: routineTime(params.get('tid') ?? '') }
}

/** Whether the handed-over routine was already sent, and where; only with a routine. */
export function parseRoutineSent(params: URLSearchParams): RoutineSent | null {
  const sent = params.get('skickad') as RoutineSent | null
  return parseRoutineQuery(params) && sent && SENT.includes(sent) ? sent : null
}
