import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid } from '@/lib/invariants/uuid'
import {
  DATA_CHOICES,
  DATA_CHOICE_CONFIG_KEYS,
  DATA_CHOICE_DEFAULTS,
  type CompanyDataChoices,
  type DataChoice,
} from './data-choices'

/**
 * Reads and the one write of a company's data choices (./data-choices.ts).
 * The rows live in company_capability_config, which members may read under
 * RLS; the write goes through set_company_data_choice with the service role.
 */

interface ConfigRow {
  capability_key: string
  enabled: boolean | null
}

function choicesFrom(rows: readonly ConfigRow[]): CompanyDataChoices {
  const out: CompanyDataChoices = { ...DATA_CHOICE_DEFAULTS }
  for (const choice of DATA_CHOICES) {
    const row = rows.find((r) => r.capability_key === DATA_CHOICE_CONFIG_KEYS[choice])
    if (row && typeof row.enabled === 'boolean') out[choice] = row.enabled
  }
  return out
}

/** The company's three choices, defaults filled in. Throws on a failed read: a settings page must not show a guess. */
export async function readCompanyDataChoices(supabase: SupabaseClient, companyId: string): Promise<CompanyDataChoices> {
  if (!isUuid(companyId)) throw new Error('readCompanyDataChoices: companyId is not a uuid')
  const { data, error } = await supabase
    .from('company_capability_config')
    .select('capability_key, enabled')
    .eq('company_id', companyId)
    .in('capability_key', Object.values(DATA_CHOICE_CONFIG_KEYS))
  if (error) throw new Error(`Failed to read data choices: ${error.message}`)
  return choicesFrom((data ?? []) as ConfigRow[])
}

/**
 * Of `companyIds`, the ones whose data must not join what is shared across
 * companies: the ones that opted out of pooling, and every sandbox company
 * (company_settings.is_sandbox), whose books are seeded demo data. Every
 * sandbox carries the same seeded bank texts, so counting them would promote
 * a demo reading to the shared directory on its own (2026-10-26 forensic
 * sweep). Throws on a failed read, so a caller that shares across companies
 * can refuse to share instead of counting a company that said no.
 */
export async function companiesWithPoolingOff(supabase: SupabaseClient, companyIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(companyIds.filter(isUuid))]
  if (ids.length === 0) return new Set()
  const { data, error } = await supabase
    .from('company_capability_config')
    .select('company_id')
    .eq('capability_key', DATA_CHOICE_CONFIG_KEYS.pooling)
    .eq('enabled', false)
    .in('company_id', ids)
  if (error) throw new Error(`Failed to read pooling choices: ${error.message}`)
  const { data: sandboxes, error: sandboxError } = await supabase
    .from('company_settings')
    .select('company_id')
    .eq('is_sandbox', true)
    .in('company_id', ids)
  if (sandboxError) throw new Error(`Failed to read sandbox companies: ${sandboxError.message}`)
  return new Set(
    [...((data ?? []) as Array<{ company_id: string }>), ...((sandboxes ?? []) as Array<{ company_id: string }>)].map((r) => r.company_id),
  )
}

/** Whether one company's patterns may join the shared ones. False on a failed read. */
export async function isPoolingOn(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  try {
    return !(await companiesWithPoolingOff(supabase, [companyId])).has(companyId)
  } catch {
    return false
  }
}

// The AI switch is read on every model call (lib/ai/meter.ts), so a company's
// answer is kept for a short while per process. Switching AI off therefore
// takes effect within AI_SWITCH_TTL_MS everywhere, and at once in the process
// that wrote it (forgetAiSwitch).
const AI_SWITCH_TTL_MS = 30_000
const aiSwitchCache = new Map<string, { off: boolean; at: number }>()

/**
 * Whether the company switched AI off. Unlike the paywall (hasCapability),
 * this holds on every deployment, local development and self-hosted
 * included: it is the customer's instruction, not an entitlement. A failed
 * read answers true (off) and is not cached: when we cannot tell, no model
 * sees the company's data.
 */
export async function isAiSwitchedOff(supabase: SupabaseClient, companyId: string, now: number = Date.now()): Promise<boolean> {
  if (!isUuid(companyId)) return false
  const hit = aiSwitchCache.get(companyId)
  if (hit && now - hit.at < AI_SWITCH_TTL_MS) return hit.off
  const { data, error } = await supabase
    .from('company_capability_config')
    .select('enabled')
    .eq('company_id', companyId)
    .eq('capability_key', DATA_CHOICE_CONFIG_KEYS.ai)
    .maybeSingle()
  if (error) return true
  const off = (data as { enabled: boolean } | null)?.enabled === false
  aiSwitchCache.set(companyId, { off, at: now })
  return off
}

/** Drop a cached AI switch answer (after the company changed it, and in tests). */
export function forgetAiSwitch(companyId?: string): void {
  if (companyId) aiSwitchCache.delete(companyId)
  else aiSwitchCache.clear()
}

export interface SetDataChoiceInput {
  companyId: string
  choice: DataChoice
  enabled: boolean
  /** The owner or admin deciding; re-checked by the RPC. */
  decidedBy: string
  actorType?: string | null
  actorLabel?: string | null
}

export type SetDataChoiceResult =
  | { ok: true; unchanged: boolean; enabled: boolean }
  | { ok: false; code: 'DATA_CHOICE_ADMIN_REQUIRED' | 'DATA_CHOICE_UNKNOWN' }

/** The one write. `service` must be a service-role client: the RPC is granted to nothing else. */
export async function setCompanyDataChoice(service: SupabaseClient, input: SetDataChoiceInput): Promise<SetDataChoiceResult> {
  const { data, error } = await service.rpc('set_company_data_choice', {
    p_company_id: input.companyId,
    p_key: DATA_CHOICE_CONFIG_KEYS[input.choice],
    p_enabled: input.enabled,
    p_decided_by: input.decidedBy,
    p_actor_type: input.actorType ?? 'user',
    p_actor_label: input.actorLabel ?? null,
  })
  if (error) throw new Error(`set_company_data_choice failed: ${error.message}`)
  const result = data as { ok: boolean; code?: string; unchanged?: boolean; enabled?: boolean }
  if (!result?.ok) {
    return { ok: false, code: result?.code === 'DATA_CHOICE_UNKNOWN' ? 'DATA_CHOICE_UNKNOWN' : 'DATA_CHOICE_ADMIN_REQUIRED' }
  }
  if (input.choice === 'ai') forgetAiSwitch(input.companyId)
  return { ok: true, unchanged: result.unchanged === true, enabled: input.enabled }
}
