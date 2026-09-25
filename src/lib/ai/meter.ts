import { AsyncLocalStorage } from 'node:async_hooks'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { createLogger } from '@/lib/logger'
import type { AiService, AiTier, AiUsage } from './types'

const log = createLogger('ai-meter')

/**
 * Who made a model call and for what, so ai_usage_events can say what each
 * feature and company costs. Optional on every request: an unlabelled call is
 * still recorded (as 'unlabeled'), so the totals never miss one.
 */
export interface AiMeter {
  feature: string
  companyId?: string | null
}

const scope = new AsyncLocalStorage<AiMeter>()

/**
 * Label every model call made inside fn, for code that calls the model a few
 * layers down without knowing the company (the page reader, the party reader).
 * A label on the request itself wins.
 */
export function withAiMeter<T>(meter: AiMeter, fn: () => Promise<T>): Promise<T> {
  return scope.run(meter, fn)
}

export function currentAiMeter(): AiMeter | undefined {
  return scope.getStore()
}

export interface AiUsageRow {
  company_id: string | null
  feature: string
  tier: string | null
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

export function usageRow(requestMeter: AiMeter | undefined, tier: AiTier | undefined, model: string, usage: AiUsage): AiUsageRow {
  const meter = requestMeter ?? currentAiMeter()
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
  return {
    company_id: meter?.companyId ?? null,
    feature: meter?.feature || 'unlabeled',
    tier: tier ?? null,
    model,
    input_tokens: n(usage.inputTokens),
    output_tokens: n(usage.outputTokens),
    cache_read_tokens: n(usage.cacheReadInputTokens),
    cache_write_tokens: n(usage.cacheCreationInputTokens),
  }
}

let client: SupabaseClient | null | undefined
function meterClient(): SupabaseClient | null {
  if (client !== undefined) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  client = url && key && process.env.NODE_ENV !== 'test' ? createServiceRoleClient(url, key) : null
  return client
}

/** Writes one row. Never throws: a meter that fails must not fail the call it measured. */
export async function recordAiUsage(row: AiUsageRow, supabase: SupabaseClient | null = meterClient()): Promise<void> {
  if (!supabase) return
  try {
    const { error } = await supabase.from('ai_usage_events').insert(row)
    if (error) log.warn('ai usage not recorded', { feature: row.feature, reason: error.message })
  } catch (err) {
    log.warn('ai usage not recorded', { feature: row.feature, reason: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The service every caller gets, recording each call's tokens after it
 * returns. One place, so a new feature is metered the day it ships.
 */
export function withMetering(service: AiService, record: (row: AiUsageRow) => Promise<void> = (row) => recordAiUsage(row)): AiService {
  return {
    get provider() {
      return service.provider
    },
    get capabilities() {
      return service.capabilities
    },
    modelFor: (tier) => service.modelFor(tier),
    async generateText(req) {
      const out = await service.generateText(req)
      await record(usageRow(req.meter, req.tier, out.model, out.usage))
      return out
    },
    async generateStructured(req) {
      const out = await service.generateStructured(req)
      await record(usageRow(req.meter, req.tier, out.model, out.usage))
      return out
    },
    async extractFromDocument(req) {
      const out = await service.extractFromDocument(req)
      if (out.ok) await record(usageRow(req.meter, req.tier ?? 'extraction', out.model, out.usage))
      return out
    },
  }
}
