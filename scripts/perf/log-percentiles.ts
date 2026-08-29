/**
 * Percentiles over structured log lines.
 *
 * Reads JSON Lines on stdin (the shape `vercel logs --json` emits, or raw
 * logger output) and prints a markdown table of count / p50 / p90 / p99 /
 * max per group for the numeric fields asked for. Used for the
 * "op completed" lines from lib/api/with-route-context.ts and the
 * "proxy completed" lines from lib/supabase/middleware.ts.
 *
 *   vercel logs --environment production --since 24h --limit 1000 --json \
 *     --query "op completed" \
 *     | npx tsx scripts/perf/log-percentiles.ts \
 *         --field durationMs,authMs,companyMs,handlerMs --group operation
 *
 *   vercel logs --environment production --since 24h --limit 1000 --json \
 *     --query "proxy completed" \
 *     | npx tsx scripts/perf/log-percentiles.ts \
 *         --field totalMs,authMs,companyMs,mfaMs --group kind,route
 *
 * Options: --field a,b (required), --group x,y (default: none, one row),
 * --filter key=value (repeatable; exact match on the parsed record),
 * --min-count N (drop groups with fewer samples, default 1).
 *
 * No dependencies on purpose: this must run from a clean checkout.
 */

export type LogRecord = Record<string, unknown>

/**
 * Turn one input line into a flat record. `vercel logs --json` wraps the
 * application line in a `message` (or `text`) string, so an embedded JSON
 * object inside that string is parsed and merged over the envelope; a bare
 * JSON logger line is used as-is. Unparseable lines yield null.
 */
export function extractRecord(line: string): LogRecord | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let envelope: LogRecord
  try {
    envelope = JSON.parse(trimmed) as LogRecord
  } catch {
    return null
  }
  const message = envelope.message ?? envelope.text
  if (typeof message === 'string') {
    const start = message.indexOf('{')
    if (start >= 0) {
      try {
        const embedded = JSON.parse(message.slice(start)) as LogRecord
        return { ...envelope, ...embedded }
      } catch {
        // Not a JSON payload: fall through and use the envelope alone.
      }
    }
  }
  return envelope
}

/** Nearest-rank percentile on an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export interface FieldStats {
  p50: number
  p90: number
  p99: number
  max: number
}

export interface GroupRow {
  group: string
  count: number
  fields: Record<string, FieldStats>
}

export interface SummarizeOptions {
  fields: string[]
  groupBy?: string[]
  filters?: Array<{ key: string; value: string }>
  minCount?: number
}

function matchesFilters(record: LogRecord, filters: SummarizeOptions['filters']): boolean {
  if (!filters || filters.length === 0) return true
  return filters.every(({ key, value }) => String(record[key]) === value)
}

export function summarize(records: LogRecord[], options: SummarizeOptions): GroupRow[] {
  const groupBy = options.groupBy ?? []
  const minCount = options.minCount ?? 1
  const buckets = new Map<string, { count: number; values: Record<string, number[]> }>()

  for (const record of records) {
    if (!matchesFilters(record, options.filters)) continue
    const groupKey = groupBy.length
      ? groupBy.map((key) => String(record[key] ?? '')).join(' / ')
      : 'all'
    let bucket = buckets.get(groupKey)
    if (!bucket) {
      bucket = {
        count: 0,
        values: Object.fromEntries(options.fields.map((f) => [f, [] as number[]])),
      }
      buckets.set(groupKey, bucket)
    }
    bucket.count += 1
    for (const field of options.fields) {
      const value = record[field]
      if (typeof value === 'number' && Number.isFinite(value)) bucket.values[field].push(value)
    }
  }

  const rows: GroupRow[] = []
  for (const [group, bucket] of buckets) {
    const count = bucket.count
    if (count < minCount) continue
    const fields: Record<string, FieldStats> = {}
    for (const field of options.fields) {
      const sorted = [...bucket.values[field]].sort((a, b) => a - b)
      fields[field] = {
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p99: percentile(sorted, 99),
        max: sorted.length ? sorted[sorted.length - 1] : Number.NaN,
      }
    }
    rows.push({ group, count, fields })
  }

  // Slowest first by the first field's p50 so the table reads as a ranking.
  const primary = options.fields[0]
  rows.sort((a, b) => (b.fields[primary]?.p50 ?? 0) - (a.fields[primary]?.p50 ?? 0))
  return rows
}

function fmt(n: number): string {
  return Number.isNaN(n) ? '-' : String(Math.round(n))
}

export function renderMarkdown(rows: GroupRow[], fields: string[]): string {
  const header = ['group', 'n', ...fields.flatMap((f) => [`${f} p50`, `${f} p90`, `${f} p99`, `${f} max`])]
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
  ]
  for (const row of rows) {
    const cells = [row.group, String(row.count)]
    for (const field of fields) {
      const s = row.fields[field]
      cells.push(fmt(s.p50), fmt(s.p90), fmt(s.p99), fmt(s.max))
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

export function parseArgs(argv: string[]): SummarizeOptions {
  const options: SummarizeOptions = { fields: [], groupBy: [], filters: [], minCount: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      const value = argv[i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--field') options.fields = next().split(',').filter(Boolean)
    else if (arg === '--group') options.groupBy = next().split(',').filter(Boolean)
    else if (arg === '--filter') {
      const [key, ...rest] = next().split('=')
      options.filters!.push({ key, value: rest.join('=') })
    } else if (arg === '--min-count') options.minCount = Number(next())
    else throw new Error(`unknown option ${arg}`)
  }
  if (options.fields.length === 0) throw new Error('--field is required')
  return options
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const input = await readStdin()
  const records = input
    .split('\n')
    .map(extractRecord)
    .filter((r): r is LogRecord => r !== null)
  const rows = summarize(records, options)
  process.stdout.write(`${records.length} records parsed\n\n`)
  process.stdout.write(`${renderMarkdown(rows, options.fields)}\n`)
}

if (process.argv[1] && /log-percentiles\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
