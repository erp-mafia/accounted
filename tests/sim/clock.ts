/**
 * The company lives through its own dates: while an event plays, `new Date()`
 * and `Date.now()` in this process answer that day, noon UTC, so everything the
 * product dates "today" (a credit note, a delivery, a default payment date)
 * lands where it would have. Postgres keeps its own clock: created_at and the
 * audit log show when the build ran, which is the truth about those rows.
 */
const RealDate = Date
let simulated: number | null = null

class SimDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(simulated ?? RealDate.now())
    else super(...(args as [string]))
  }

  static now(): number {
    return simulated ?? RealDate.now()
  }
}

export function installSimClock(): void {
  globalThis.Date = SimDate as DateConstructor
}

export function setSimDay(date: string): void {
  simulated = RealDate.parse(`${date}T12:00:00Z`)
}
