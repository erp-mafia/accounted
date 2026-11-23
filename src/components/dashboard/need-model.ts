/**
 * Hem's arithmetic. Nothing on Hem is a sentence written for one item or one
 * day: the headline is one of four templates filled with counts, "Först" is
 * the rows that fall due soonest, and a group's line is the names of its rows
 * cut after three. Everything here is pure, so the templates can be tested
 * against counts of 0, 1 and many without rendering a page.
 */

/** What the person has to do, in the order Hem and Börja run the groups. */
export const NEED_GROUPS = ['attest', 'pay', 'sign', 'book', 'decide', 'review', 'upload', 'watch'] as const
export type NeedGroup = (typeof NEED_GROUPS)[number]

/** The part of a row the arithmetic reads. */
export interface NeedRowFacts {
  key: string
  group: NeedGroup
  /** The row's own name in a group line: the supplier, the document, the person, else the row's label. */
  name: string
  /** The date the row falls due (ISO yyyy-MM-dd), when its data has one. */
  due?: string | null
  /** The data says it cannot wait (a failed payment, changed bank details, a stopped feed). */
  urgent?: boolean
  /**
   * How many things the row stands for: 5 for "Betala 5 leverantörsfakturor",
   * 1 (the default) for a row that is one thing. 0 for a row that is a second
   * view of things another row already counts (a suggested match is one of
   * the transactions to book).
   */
  things?: number
  /** How many of them are urgent when the row is; defaults to all of them. */
  urgentThings?: number
}

/**
 * The views of Att göra on "/": Hem, which lists what needs the person, and
 * by ?vy= the walk-through and what was done. The list that once had a view
 * of its own (?vy=behover) is Hem: an old link to it opens Hem.
 */
export const HEM_VIEWS = ['hem', 'borja', 'gjort'] as const
export type HemViewName = (typeof HEM_VIEWS)[number]

/** The view a ?vy= value asks for; anything else (absent, repeated, unknown, the old list) is Hem. */
export function parseHemView(vy: string | string[] | undefined): HemViewName {
  const value = Array.isArray(vy) ? vy[0] : vy
  return HEM_VIEWS.find((view) => view === value) ?? 'hem'
}

/** How many things a row stands for. */
export function thingsOf(row: NeedRowFacts): number {
  return Math.max(0, Math.floor(row.things ?? 1))
}

/** The things behind a list of rows: what the headline and a group title count. */
export function countThings(rows: readonly NeedRowFacts[]): number {
  return rows.reduce((sum, row) => sum + thingsOf(row), 0)
}

/** The urgent things among them. */
export function countUrgentThings(rows: readonly NeedRowFacts[], todayIso: string): number {
  return rows.reduce(
    (sum, row) => sum + (isUrgentRow(row, todayIso) ? Math.min(thingsOf(row), Math.max(0, Math.floor(row.urgentThings ?? thingsOf(row)))) : 0),
    0,
  )
}

/**
 * The company's invoices to attest that the person's own attest rows do not
 * already show: the per-person rows are a view of the same invoices, so the
 * company row counts only the rest.
 */
export function attestRemainder(companyCount: number, personRows: number): number {
  return Math.max(0, Math.floor(companyCount) - Math.max(0, Math.floor(personRows)))
}

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'later'

/** The day after an ISO date, in plain calendar math (no time zone involved). */
export function nextIsoDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/** Where a due date stands against today; null without a readable date. */
export function dueStateOf(due: string | null | undefined, todayIso: string): DueState | null {
  if (!due || !/^\d{4}-\d{2}-\d{2}/.test(due)) return null
  const day = due.slice(0, 10)
  if (day < todayIso) return 'overdue'
  if (day === todayIso) return 'today'
  if (day === nextIsoDay(todayIso)) return 'tomorrow'
  return 'later'
}

/** Urgent: the data flags it, or it falls due today or tomorrow, or is past due. */
export function isUrgentRow(row: NeedRowFacts, todayIso: string): boolean {
  if (row.urgent) return true
  const state = dueStateOf(row.due, todayIso)
  return state !== null && state !== 'later'
}

export type HeadlineKind = 'clear' | 'waiting' | 'urgent' | 'urgent_only' | 'not_started'

/**
 * Which headline template applies and its counts:
 * clear ("Allt är klart."), waiting ("Inget brådskar. N saker väntar."),
 * urgent ("N saker brådskar. M till väntar.") and urgent_only when nothing
 * else waits behind the urgent rows. An empty list for a company that has not
 * got going (`started` false: nothing booked and nothing on its way) is
 * not_started, never clear: nothing waiting is no achievement there.
 */
export function headlineOf(
  urgent: number,
  total: number,
  started = true,
): { kind: HeadlineKind; urgent: number; rest: number; total: number } {
  const all = Math.max(0, Math.floor(total))
  const hot = Math.min(all, Math.max(0, Math.floor(urgent)))
  const rest = all - hot
  const kind: HeadlineKind =
    all === 0 ? (started ? 'clear' : 'not_started') : hot === 0 ? 'waiting' : rest === 0 ? 'urgent_only' : 'urgent'
  return { kind, urgent: hot, rest, total: all }
}

/**
 * "Först": the rows that fall due soonest, at most `limit`. Only rows with a
 * due date or the urgent flag take part; a flagged row without a date counts
 * as due today. The order within one day is the order the rows came in.
 */
export function firstRows<T extends NeedRowFacts>(rows: readonly T[], todayIso: string, limit = 3): T[] {
  const dated = rows
    .map((row, index) => ({ row, index, day: row.due ? row.due.slice(0, 10) : row.urgent ? todayIso : null }))
    .filter((entry): entry is { row: T; index: number; day: string } => entry.day !== null)
  dated.sort((a, b) => (a.day === b.day ? a.index - b.index : a.day < b.day ? -1 : 1))
  return dated.slice(0, Math.max(0, limit)).map((entry) => entry.row)
}

/** The rows per group, in NEED_GROUPS order; a group without rows is left out. */
export function groupRows<T extends NeedRowFacts>(rows: readonly T[]): Array<{ group: NeedGroup; rows: T[] }> {
  return NEED_GROUPS.map((group) => ({ group, rows: rows.filter((row) => row.group === group) })).filter(
    (entry) => entry.rows.length > 0,
  )
}

/** A group's line: the first `keep` names and how many more there are. */
export function groupNames(names: readonly string[], keep = 3): { shown: string[]; more: number } {
  const clean = names.map((name) => name.trim()).filter(Boolean)
  return { shown: clean.slice(0, keep), more: Math.max(0, clean.length - keep) }
}

/**
 * The names of a group's rows for its line on Hem. A count follows a name
 * where the group's title does not already say that number: in a group of
 * several rows, and in a group whose title counts differently (a backlog of
 * 587 vouchers is one thing to the headline).
 */
export function groupNameParts(
  rows: ReadonlyArray<NeedRowFacts & { count?: number }>,
): string[] {
  const titleCount = countThings(rows)
  return rows.map((row) =>
    row.count !== undefined && row.count > 1 && (rows.length > 1 || row.count !== titleCount) ? `${row.name} (${row.count})` : row.name,
  )
}

/** How many rows of a group the list shows before "Visa alla N". */
export const GROUP_ROWS_SHOWN = 10

/** The rows a group shows: all of them when open or short, else the first `cap` (never a lone hidden row). */
export function shownRows<T>(rows: readonly T[], open: boolean, cap = GROUP_ROWS_SHOWN): { shown: T[]; hidden: number } {
  if (open || rows.length <= cap + 1) return { shown: [...rows], hidden: 0 }
  return { shown: rows.slice(0, cap), hidden: rows.length - cap }
}

/**
 * Two newest-first pages of one log (approved and rejected) as one list,
 * newest first. A page that came back full has older rows behind it that
 * were not read, so nothing older than its last row is shown from the other
 * page either: what is listed is then exactly the newest rows of the log.
 */
export function mergeLatest<T>(pages: ReadonlyArray<readonly T[]>, pageSize: number, when: (row: T) => string): T[] {
  let floor = ''
  for (const page of pages) {
    if (page.length >= pageSize && page.length > 0) {
      const oldest = page.reduce((min, row) => (when(row) < min ? when(row) : min), when(page[0]))
      if (oldest > floor) floor = oldest
    }
  }
  return pages
    .flat()
    .filter((row) => when(row) >= floor)
    .sort((a, b) => (when(a) === when(b) ? 0 : when(a) < when(b) ? 1 : -1))
}

/** A day against today, for a day heading: today, yesterday or another day. */
export function dayKindOf(dayIso: string, todayIso: string): 'today' | 'yesterday' | 'other' {
  if (dayIso === todayIso) return 'today'
  return nextIsoDay(dayIso) === todayIso ? 'yesterday' : 'other'
}

/** How many queue rows of one group Börja lists beside the step. */
export const QUEUE_ROWS_SHOWN = 8

/**
 * The slice of a group the Börja queue lists: all of a short group, the
 * first rows of a long one, or the rows around the step on screen. `before`
 * and `after` are how many rows are left out on each side.
 */
export function queueWindow<T>(rows: readonly T[], current: number, cap = QUEUE_ROWS_SHOWN): { shown: T[]; before: number; after: number } {
  if (rows.length <= cap) return { shown: [...rows], before: 0, after: 0 }
  const start = current < 0 ? 0 : Math.min(Math.max(0, current - 2), rows.length - cap)
  return { shown: rows.slice(start, start + cap), before: start, after: rows.length - start - cap }
}
