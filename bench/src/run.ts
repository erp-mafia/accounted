// Accounted Ledger-Bench runner.
//
//   npx tsx bench/src/run.ts --suite booking --model claude-haiku-4-5
//   npx tsx bench/src/run.ts --suite all --model enabled --limit 5
//
// Each run appends JSONL records to bench/results/runs/. Aggregation into the
// leaderboard is a separate step (aggregate.ts) so results can be recomputed
// without re-running models.

import fs from 'node:fs'
import path from 'node:path'
import { config as loadEnv } from 'dotenv'
import { BENCH_ROOT } from './util'
// Credentials come from the repo's .env.local when present (ANTHROPIC_API_KEY
// / AWS keys / OPENROUTER_API_KEY). Nothing else in that file is read.
loadEnv({ path: path.join(BENCH_ROOT, '..', '.env.local') })
import { MODELS, getModel, type ModelSpec } from './models'
import type { RunRecord, SuiteId, Task } from './types'
import { loadBookingTasks, runBookingTask } from './suites/booking'
import { loadReasoningTasks, runReasoningTask } from './suites/reasoning'
import { loadExtractionTasks, runExtractionTask } from './suites/extraction'
import { loadLedgerAgentTasks, runLedgerAgentTask } from './suites/ledger-agent'
import { closePool } from './ledger-env'
import { resultsDir } from './util'
import type { BookingTask, ExtractionTask, LedgerAgentTask, ReasoningTask } from './types'

interface Args {
  suite: SuiteId | 'all'
  models: ModelSpec[]
  limit: number | null
  concurrency: number
  taskFilter: string | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  const suite = (get('--suite') ?? 'all') as Args['suite']
  const modelArg = get('--model') ?? 'enabled'
  const models =
    modelArg === 'enabled'
      ? MODELS.filter((m) => m.enabled)
      : modelArg.split(',').map((id) => getModel(id.trim()))
  const limitRaw = get('--limit')
  return {
    suite,
    models,
    limit: limitRaw ? Number(limitRaw) : null,
    concurrency: Number(get('--concurrency') ?? '4'),
    taskFilter: get('--task'),
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

async function runSuite(
  suite: SuiteId,
  spec: ModelSpec,
  args: Args,
): Promise<RunRecord[]> {
  let tasks: Task[]
  let runner: (spec: ModelSpec, task: never) => Promise<RunRecord>
  let concurrency = args.concurrency
  switch (suite) {
    case 'booking':
      tasks = loadBookingTasks()
      runner = runBookingTask as never
      break
    case 'reasoning':
      tasks = loadReasoningTasks()
      runner = runReasoningTask as never
      break
    case 'extraction':
      tasks = loadExtractionTasks()
      runner = runExtractionTask as never
      break
    case 'ledger-agent':
      tasks = loadLedgerAgentTasks()
      runner = runLedgerAgentTask as never
      // Trials share the database but not tenants; keep it sequential anyway
      // so voucher timelines in one trial are never interleaved with another.
      concurrency = 1
      break
    default:
      throw new Error(`Unknown suite ${suite}`)
  }
  if (args.taskFilter) tasks = tasks.filter((t) => t.id.includes(args.taskFilter!))
  if (args.limit) tasks = tasks.slice(0, args.limit)
  if (suite === 'extraction' && !spec.vision) {
    console.log(`  ${spec.id}: no vision, skipping extraction`)
    return []
  }

  const records = await mapWithConcurrency(tasks, concurrency, async (task) => {
    try {
      const rec = await runner(spec, task as never)
      const mark = rec.pass ? 'PASS' : 'fail'
      console.log(
        `  [${suite}] ${task.id} ${spec.id}: ${mark} ` +
          `($${rec.usage.costUsd.toFixed(4)}, ${rec.turns}t, ${(rec.durationMs / 1000).toFixed(1)}s)`,
      )
      return rec
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.log(`  [${suite}] ${task.id} ${spec.id}: ERROR ${message.slice(0, 200)}`)
      return {
        benchVersion: 'v1',
        suite,
        taskId: task.id,
        model: spec.id,
        provider: spec.provider,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        pass: false,
        score: { harnessError: true },
        error: message,
      } satisfies RunRecord
    }
  })
  return records
}

async function main() {
  const args = parseArgs()
  const suites: SuiteId[] =
    args.suite === 'all'
      ? ['booking', 'reasoning', 'extraction', 'ledger-agent']
      : [args.suite]

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const spec of args.models) {
    for (const suite of suites) {
      console.log(`== ${suite} / ${spec.id} ==`)
      const records = await runSuite(suite, spec, args)
      if (records.length === 0) continue
      const file = path.join(resultsDir(), `${stamp}-${suite}-${spec.id}.jsonl`)
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
      const passed = records.filter((r) => r.pass).length
      const cost = records.reduce((s, r) => s + r.usage.costUsd, 0)
      console.log(
        `== ${suite} / ${spec.id}: ${passed}/${records.length} pass, $${cost.toFixed(3)} -> ${path.basename(file)}`,
      )
    }
  }
  await closePool()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

// Type-only usage keeps the suite task types exported for other tooling.
export type { BookingTask, ReasoningTask, ExtractionTask, LedgerAgentTask }
