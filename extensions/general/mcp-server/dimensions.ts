/**
 * Dimension helpers for the MCP server (PR3 of the dimensions plan:
 * dev_docs/dimensions_implementation_plan.md §6).
 *
 * Two responsibilities, shared by the dimension tools and the dims-bag write
 * tools (gnubok_create_voucher / gnubok_correct_entry):
 *
 *   1. Registry access: ensure_company_dimensions + the same two-query fetch
 *      the dashboard GET /api/dimensions uses, returning the identical shape.
 *
 *   2. Resolve-don't-select: an incoming dimension value may be an object
 *      code ("KS01") OR a natural-language name ("Villa Almgren tak"). The
 *      server resolves exact code → exact name → fuse.js fuzzy over the
 *      dimension's ACTIVE values. A single high-confidence hit resolves (and
 *      is echoed back with its confidence); multiple/low-confidence candidates
 *      reject with a ranked list so the agent retries with a code or stages
 *      gnubok_create_dimension_value. NO auto-create, ever: agents must not
 *      silently mint reporting values.
 *
 * Resolution honours the validation contract: company_settings.dimensions_enabled
 * is fetched ONCE; when false the bags pass through verbatim (free-text
 * backward compatibility: the engine skips validation too), when true every
 * value must land on an active registry value. Untagged entries cost zero
 * queries.
 */
import Fuse from 'fuse.js'
import { roundOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  DimensionsBagSchema,
  normalizeLineDimensions,
  type LineDimensions,
} from '@/lib/bookkeeping/dimension-resolver'

// ── Registry shapes (mirror GET /api/dimensions exactly) ─────────────────────

export interface DimensionValueEntry {
  id: string
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

export interface DimensionRegistryEntry {
  id: string
  sie_dim_no: number
  name: string
  resets_annually: boolean
  is_system: boolean
  is_active: boolean
  sort_order: number
  values: DimensionValueEntry[]
}

/**
 * Lazy get-or-create of the system dims (1 = Kostnadsställe, 6 = Projekt).
 * Idempotent; keeps core zero-config for companies that never touch dimensions.
 */
export async function ensureCompanyDimensions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<void> {
  const { error } = await supabase.rpc('ensure_company_dimensions', {
    p_company_id: companyId,
  })
  if (error) throw new Error(`Failed to seed system dimensions: ${error.message}`)
}

/**
 * Fetch the full registry incl. values: the same two queries and the same
 * nested shape as the dashboard GET /api/dimensions, so agents and the
 * register UI see one consistent contract.
 */
export async function fetchDimensionRegistry(
  supabase: SupabaseClient,
  companyId: string,
): Promise<DimensionRegistryEntry[]> {
  const { data: dims, error: dimsError } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, name, resets_annually, is_system, is_active, sort_order')
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true })
    .order('sie_dim_no', { ascending: true })
  if (dimsError) throw new Error(`Failed to list dimensions: ${dimsError.message}`)

  const { data: values, error: valuesError } = await supabase
    .from('dimension_values')
    .select('id, dimension_id, code, name, is_active, start_date, end_date')
    .eq('company_id', companyId)
    .order('code', { ascending: true })
  if (valuesError) throw new Error(`Failed to list dimension values: ${valuesError.message}`)

  const valuesByDimension = new Map<string, DimensionValueEntry[]>()
  for (const v of (values ?? []) as Array<DimensionValueEntry & { dimension_id: string }>) {
    const bucket = valuesByDimension.get(v.dimension_id) ?? []
    bucket.push({
      id: v.id,
      code: v.code,
      name: v.name,
      is_active: v.is_active,
      start_date: v.start_date,
      end_date: v.end_date,
    })
    valuesByDimension.set(v.dimension_id, bucket)
  }

  return ((dims ?? []) as Array<Omit<DimensionRegistryEntry, 'values'>>).map((d) => ({
    ...d,
    values: valuesByDimension.get(d.id) ?? [],
  }))
}

// ── Input parsing ────────────────────────────────────────────────────────────

/**
 * MCP boundary schema for a dimensions bag where values may be NAMES, not just
 * codes. Looser than DimensionsBagSchema on length (names go up to 120 chars,
 * dimension_values.name CHECK) but keeps the SIE-framing charset ban. After
 * resolution the final bags are re-validated against DimensionsBagSchema (the
 * exact schema the API layer and staged commit path use) so nothing loose is
 * ever staged.
 */
const DimensionsInputSchema = z.record(
  z.string().regex(/^[1-9]\d*$/, 'nyckeln måste vara ett SIE-dimensionsnummer (t.ex. "1" eller "6")'),
  z
    .string()
    .min(1)
    .max(120)
    .regex(/^[^"{}]+$/, 'värdet får inte innehålla ", { eller }'),
)

/**
 * Parse an untyped `dimensions` / `default_dimensions` tool argument. Throws a
 * loud, actionable error on invalid shape: the MCP boundary is an input gate,
 * unlike coerceDimensionsBag (which silently drops on the trusted staged path).
 */
export function parseDimensionsArg(raw: unknown, field: string): LineDimensions | undefined {
  if (raw === undefined || raw === null) return undefined
  const parsed = DimensionsInputSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `Invalid ${field}: ${issue?.message ?? 'ogiltig dimensionsmap'}. ` +
      'Expected {"<sie_dim_no>":"<kod eller namn>"}, e.g. {"1":"KS01","6":"P001"}.',
    )
  }
  const dims = normalizeLineDimensions({ dimensions: parsed.data })
  return Object.keys(dims).length > 0 ? dims : undefined
}

// ── Resolve-don't-select ─────────────────────────────────────────────────────

/**
 * Fuse score cutoff for a single high-confidence fuzzy hit. Fuse scores run
 * 0 (perfect) → 1 (no relation); 0.3 matches the app-wide precedent for
 * registry lookups (components/import/OpeningBalanceRowEditor.tsx uses
 * threshold 0.3 for BAS account search). Anything above is "plausible but not
 * safe to attach": plan risk #5 is a confident-but-wrong project tag.
 */
export const DIMENSION_FUZZY_SCORE_MAX = 0.3
/**
 * Minimum score gap to the runner-up before a fuzzy hit counts as unambiguous.
 * Two near-tied candidates (e.g. "P001 Villa Alm" vs "P002 Villa Alm etapp 2")
 * must be disambiguated by the agent, not guessed at.
 */
export const DIMENSION_FUZZY_AMBIGUITY_MARGIN = 0.15

/** Echoed in tool responses for every non-exact resolution. */
export interface DimensionResolution {
  dimension: number
  input: string
  resolved_code: string
  resolved_name: string
  /** 1 for exact code/name matches; 1 − fuse score (2 decimals) for fuzzy. */
  confidence: number
}

/** Typed rejection so tests/tools can distinguish resolution failures. */
export class DimensionResolutionError extends Error {
  readonly dimension: number
  readonly input: string
  readonly candidates: Array<{ code: string; name: string; confidence: number }>

  constructor(
    message: string,
    dimension: number,
    input: string,
    candidates: Array<{ code: string; name: string; confidence: number }> = [],
  ) {
    super(message)
    this.name = 'DimensionResolutionError'
    this.dimension = dimension
    this.input = input
    this.candidates = candidates
  }
}

function dimensionLabel(dim: Pick<DimensionRegistryEntry, 'sie_dim_no' | 'name'>): string {
  if (dim.sie_dim_no === 1) return 'kostnadsställe'
  if (dim.sie_dim_no === 6) return 'projekt'
  return dim.name
}

interface ResolvedValue {
  code: string
  name: string
  exact: boolean
  confidence: number
}

/**
 * Resolve one input (code or name) inside one dimension. Pure: takes registry
 * data, so it is unit-testable without a DB. Throws DimensionResolutionError
 * on archived / unknown / ambiguous inputs; never auto-creates.
 */
export function resolveValueInDimension(
  dim: DimensionRegistryEntry,
  input: string,
): ResolvedValue {
  const active = dim.values.filter((v) => v.is_active)
  const label = dimensionLabel(dim)

  // 1. Exact code match among active values: the fast path, not echoed.
  const exactCode = active.find((v) => v.code === input)
  if (exactCode) return { code: exactCode.code, name: exactCode.name, exact: true, confidence: 1 }

  // Archived guard: an exact code hit on an inactive value is a hard stop:
  // same rule the engine enforces at draft time.
  const archived = dim.values.find((v) => !v.is_active && v.code === input)
  if (archived) {
    throw new DimensionResolutionError(
      `"${input}" är arkiverat: återaktivera värdet för att använda det.`,
      dim.sie_dim_no,
      input,
    )
  }

  // 2. Exact (case-insensitive) code or exact name match: unambiguous but
  //    echoed, since the stored code differs from the raw input.
  const lowered = input.trim().toLowerCase()
  const exactish = active.filter(
    (v) => v.code.toLowerCase() === lowered || v.name.trim().toLowerCase() === lowered,
  )
  if (exactish.length === 1) {
    return { code: exactish[0].code, name: exactish[0].name, exact: false, confidence: 1 }
  }
  if (exactish.length > 1) {
    throw new DimensionResolutionError(
      `"${input}" matchar flera värden i ${label} (dimension ${dim.sie_dim_no}): ` +
      exactish.map((v) => `"${v.code}" (${v.name})`).join(', ') +
      '. Ange en exakt kod i stället.',
      dim.sie_dim_no,
      input,
      exactish.map((v) => ({ code: v.code, name: v.name, confidence: 1 })),
    )
  }

  // 3. Fuzzy over active values.
  const fuse = new Fuse(active, {
    keys: ['code', 'name'],
    includeScore: true,
    threshold: 0.4,
  })
  const hits = fuse.search(input)

  if (hits.length === 0) {
    throw new DimensionResolutionError(
      `Okänt ${label}: "${input}" (dimension ${dim.sie_dim_no}). Skapa värdet i registret först: ` +
      'stage det med gnubok_create_dimension_value, eller ange en befintlig kod ' +
      '(gnubok_list_dimension_values).',
      dim.sie_dim_no,
      input,
    )
  }

  const top = hits[0]
  const topScore = top.score ?? 1
  const runnerUpScore = hits[1]?.score ?? Number.POSITIVE_INFINITY
  const unambiguous =
    topScore <= DIMENSION_FUZZY_SCORE_MAX &&
    runnerUpScore - topScore >= DIMENSION_FUZZY_AMBIGUITY_MARGIN

  if (unambiguous) {
    return {
      code: top.item.code,
      name: top.item.name,
      exact: false,
      confidence: roundOre(1 - topScore),
    }
  }

  const candidates = hits.slice(0, 5).map((h) => ({
    code: h.item.code,
    name: h.item.name,
    confidence: roundOre(1 - (h.score ?? 1)),
  }))
  throw new DimensionResolutionError(
    `Kunde inte entydigt matcha "${input}" mot ett ${label} (dimension ${dim.sie_dim_no}). Kandidater: ` +
    candidates.map((c) => `"${c.code}" (${c.name}, ${Math.round(c.confidence * 100)}%)`).join(', ') +
    '. Ange en exakt kod, eller skapa ett nytt värde med gnubok_create_dimension_value.',
    dim.sie_dim_no,
    input,
    candidates,
  )
}

export interface ResolveBagsResult {
  /** Same length/positions as the input; values rewritten to registry codes. */
  bags: Array<LineDimensions | undefined>
  /** One entry per distinct non-exact (dimension, input) pair. */
  resolutions: DimensionResolution[]
}

/**
 * Resolve the dimension bags of a whole voucher in one pass.
 *
 * Query budget (validation contract): zero queries when no line carries a
 * bag; one company_settings read when dimensions are disabled (free-text
 * passthrough); ensure-RPC + two registry reads when enabled. Never per-line.
 */
export async function resolveDimensionBags(
  supabase: SupabaseClient,
  companyId: string,
  bags: Array<LineDimensions | undefined>,
): Promise<ResolveBagsResult> {
  const hasAny = bags.some((b) => b && Object.keys(b).length > 0)
  if (!hasAny) return { bags, resolutions: [] }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('dimensions_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  const finalize = (resolved: Array<LineDimensions | undefined>): void => {
    // Whatever path produced the bags, the staged result must satisfy THE bag
    // schema (max 40-char codes, SIE-safe charset): otherwise the commit-side
    // coerceDimensionsBag would silently drop the whole bag at booking time.
    for (const bag of resolved) {
      if (!bag) continue
      const check = DimensionsBagSchema.safeParse(bag)
      if (!check.success) {
        const issue = check.error.issues[0]
        throw new Error(
          `Ogiltig dimensionskod: ${issue?.message ?? 'ogiltigt värde'}. ` +
          'Koder får vara max 40 tecken: registrera värdet i registret och referera det via kod eller namn.',
        )
      }
    }
  }

  if (!(settings as { dimensions_enabled?: boolean } | null)?.dimensions_enabled) {
    // Dimensions not enabled: free-text passthrough, exactly like the engine's
    // validation rule 2: existing API/MCP writers keep working unchanged.
    finalize(bags)
    return { bags, resolutions: [] }
  }

  await ensureCompanyDimensions(supabase, companyId)
  const registry = await fetchDimensionRegistry(supabase, companyId)
  const byDimNo = new Map(registry.map((d) => [d.sie_dim_no, d]))

  const cache = new Map<string, ResolvedValue & { dimension: number; input: string }>()
  const resolveOne = (dimNo: string, input: string) => {
    const key = `${dimNo}\u0000${input}`
    const cached = cache.get(key)
    if (cached) return cached
    const dim = byDimNo.get(Number(dimNo))
    if (!dim) {
      throw new DimensionResolutionError(
        `Okänd dimension ${dimNo}. Registrerade dimensioner: ` +
        (registry.map((d) => `${d.sie_dim_no} (${d.name})`).join(', ') || 'inga') +
        '. Anropa gnubok_list_dimensions.',
        Number(dimNo),
        input,
      )
    }
    const resolved = { ...resolveValueInDimension(dim, input), dimension: dim.sie_dim_no, input }
    cache.set(key, resolved)
    return resolved
  }

  const outBags = bags.map((bag) => {
    if (!bag || Object.keys(bag).length === 0) return bag
    const out: LineDimensions = {}
    for (const [dimNo, value] of Object.entries(bag)) {
      out[dimNo] = resolveOne(dimNo, value).code
    }
    return out
  })

  const resolutions: DimensionResolution[] = [...cache.values()]
    .filter((r) => !r.exact)
    .map((r) => ({
      dimension: r.dimension,
      input: r.input,
      resolved_code: r.code,
      resolved_name: r.name,
      confidence: r.confidence,
    }))

  finalize(outBags)
  return { bags: outBags, resolutions }
}

/**
 * Per-line effective bag for a voucher tool: the line's own normalized map
 * (explicit bag wins over the deprecated cost_center/project aliases) filled
 * with voucher-level defaults for keys the line does not set itself.
 */
export function mergeLineDimensions(
  line: { dimensions?: LineDimensions; cost_center?: string; project?: string },
  defaults: LineDimensions | undefined,
): LineDimensions | undefined {
  const own = normalizeLineDimensions({
    dimensions: line.dimensions ?? null,
    cost_center: line.cost_center ?? null,
    project: line.project ?? null,
  })
  const merged = { ...(defaults ?? {}), ...own }
  return Object.keys(merged).length > 0 ? merged : undefined
}
