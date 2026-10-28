/**
 * Run detectors: build the context for one company and firing, walk each
 * detector's subjects, check the condition and stage what holds. The one
 * place a detector meets the database's write side, shared by the event
 * consumer (./handler.ts) and the daily sweep (./sweep.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CoreEvent } from '@/lib/events/types'
import type { Logger } from '@/lib/logger'
import { loadCompanyCapabilities, type CompanyCapabilities } from '@/lib/modules/capabilities'
import { stageSuggestion, type StageOutcome } from './stage'
import type { Detector, DetectorContext } from './types'
import { toError } from '@/lib/errors/to-error'

export function createDetectorContext(input: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
  now?: Date
}): DetectorContext {
  const memos = new Map<string, Promise<unknown>>()
  const memo = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let value = memos.get(key) as Promise<T> | undefined
    if (!value) {
      value = load()
      memos.set(key, value)
    }
    return value
  }
  return {
    supabase: input.supabase,
    companyId: input.companyId,
    userId: input.userId,
    now: input.now ?? new Date(),
    log: input.log,
    memo,
    // A read that fails is no capabilities, and so no condition holds.
    capabilities: () =>
      memo<CompanyCapabilities | null>('capabilities', () =>
        loadCompanyCapabilities(input.supabase, input.companyId).catch((err: unknown) => {
          input.log.warn('capabilities could not be read for a suggestion', {
            companyId: input.companyId,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        }),
      ),
  }
}

export interface DetectorRunResult {
  detector: string
  key: string
  outcome: StageOutcome
}

/**
 * Run one detector for one firing: every subject whose condition holds is
 * staged. `maxStaged` stops after that many new stagings (the sweep stages
 * at most one per company and run). Never throws: a failing condition is
 * logged and the next subject is tried.
 */
export async function runDetector<TSubject>(
  detector: Detector<TSubject>,
  ctx: DetectorContext,
  event: CoreEvent | null,
  opts: { maxStaged?: number } = {},
): Promise<DetectorRunResult[]> {
  if (detector.enabled && !detector.enabled()) return []
  const results: DetectorRunResult[] = []
  let staged = 0
  let subjects: readonly TSubject[]
  try {
    subjects = await detector.subjects(ctx, event)
  } catch (err) {
    ctx.log.error('suggestion detector failed to read its subjects', toError(err), {
      detector: detector.id,
      companyId: ctx.companyId,
    })
    return results
  }
  for (const subject of subjects) {
    if (opts.maxStaged !== undefined && staged >= opts.maxStaged) break
    let holds = false
    try {
      holds = await detector.condition(ctx, subject)
    } catch (err) {
      ctx.log.error('suggestion detector condition failed', toError(err), {
        detector: detector.id,
        companyId: ctx.companyId,
      })
      continue
    }
    if (!holds) continue
    const proposal = detector.propose(subject)
    const outcome = await stageSuggestion(ctx, detector.id, proposal)
    if (outcome.staged) staged++
    results.push({ detector: detector.id, key: proposal.key, outcome })
  }
  return results
}
