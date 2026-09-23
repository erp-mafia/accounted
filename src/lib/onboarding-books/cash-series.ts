/**
 * The cash line after the first bank fetch: one point per day from the
 * lookback start to today, anchored on today's balance and walked backwards
 * through the fetched transactions. Nothing is estimated: a day without
 * rows keeps the previous balance. The named moments are the biggest
 * outflows and the single biggest inflow, labelled with the counterpart's
 * own text and carrying their signed amount for the chart's lane.
 */

export interface CashTx {
  date: string
  amount: number
  description: string | null
}

export interface CashPoint {
  d: Date
  v: number
  inflow: number
  outflow: number
  /** Short label for a named moment on this day, or null. */
  ev: string | null
  /** The named moment's signed amount (the day's outflow, negative), or null. */
  evAmount: number | null
}

export interface CashSeriesInput {
  transactions: CashTx[]
  /** Today's booked balance across the fetched accounts. */
  balanceToday: number
  fromDate: string
  today: string
  /** How many outflows to name (the biggest ones). */
  nameOutflows?: number
  outflowFallbackLabel?: string
}

const DAY_MS = 86_400_000

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

export function shortLabel(text: string | null, max = 16, fallback = ''): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return fallback
  const first = clean.split(/[,/|]/)[0].trim()
  const s = first.length ? first : clean
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

export function buildCashSeries(input: CashSeriesInput): CashPoint[] {
  const from = Date.parse(`${dayKey(input.fromDate)}T00:00:00Z`)
  const to = Date.parse(`${dayKey(input.today)}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const days = Math.round((to - from) / DAY_MS) + 1

  const perDay = new Map<string, { inflow: number; outflow: number; net: number; big: { amount: number; text: string | null } | null }>()
  for (const tx of input.transactions) {
    const k = dayKey(tx.date)
    const row = perDay.get(k) ?? { inflow: 0, outflow: 0, net: 0, big: null }
    if (tx.amount >= 0) row.inflow = round2(row.inflow + tx.amount)
    else row.outflow = round2(row.outflow - tx.amount)
    row.net = round2(row.net + tx.amount)
    if (tx.amount < 0 && (!row.big || -tx.amount > row.big.amount)) row.big = { amount: -tx.amount, text: tx.description }
    if (tx.amount > 0 && (!row.big || tx.amount > row.big.amount)) row.big = { amount: tx.amount, text: tx.description }
    perDay.set(k, row)
  }

  // Walk backwards from today's balance so the line ends on a real number.
  const values = new Array<number>(days)
  let v = input.balanceToday
  for (let i = days - 1; i >= 0; i--) {
    values[i] = round2(v)
    const iso = new Date(from + i * DAY_MS).toISOString().slice(0, 10)
    const row = perDay.get(iso)
    if (row) v = round2(v - row.net)
  }

  const points: CashPoint[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(from + i * DAY_MS)
    const iso = d.toISOString().slice(0, 10)
    const row = perDay.get(iso)
    points.push({ d, v: values[i], inflow: row?.inflow ?? 0, outflow: row?.outflow ?? 0, ev: null, evAmount: null })
  }

  // Name the biggest outflows: the moments the line dips for.
  const nameN = input.nameOutflows ?? 3
  const ranked = points
    .map((p, i) => ({ i, out: p.outflow }))
    .filter((r) => r.out > 0)
    .sort((a, b) => b.out - a.out)
    .slice(0, nameN)
  for (const r of ranked) {
    const iso = points[r.i].d.toISOString().slice(0, 10)
    const row = perDay.get(iso)
    points[r.i].ev = shortLabel(row?.big && row.big.amount === r.out ? row.big.text : null, 16, input.outflowFallbackLabel)
    points[r.i].evAmount = -r.out
  }
  return points
}

/** The biggest inflow's label and amount, for the sage mark above the line. */
export function biggestInflow(transactions: CashTx[], fallback = ''): { label: string; amount: number } | null {
  let best: CashTx | null = null
  for (const tx of transactions) if (tx.amount > 0 && (!best || tx.amount > best.amount)) best = tx
  return best ? { label: shortLabel(best.description, 20, fallback), amount: best.amount } : null
}
