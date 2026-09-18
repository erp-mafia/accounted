/**
 * /api/v1/companies/{companyId}/salary/settings: the company's payroll
 * settings, so an external payroll operator can provision a customer over the
 * API instead of the dashboard (payroll gap-closure 4).
 *
 * GET:   the salary settings resource. A company without a company_settings
 *        row yet answers with the engine defaults (pay day 25, same_month,
 *        pain001, no bank, no öre rounding, series A: the resolver fallback
 *        when there is no row to read).
 * PATCH: partial update. Upserts: the row is updated when it exists and
 *        inserted (company_id + user_id + the supplied columns, DB defaults
 *        for the rest) when it does not. Idempotent (mandatory
 *        Idempotency-Key). Dry-runnable.
 *
 * `salary_voucher_series` is not a column. It is
 * company_settings.default_voucher_series_per_source_type.salary_payment,
 * read through resolveDefaultSeriesForSource (the same call the salary-run
 * engine makes) and written by MERGING into the existing map, exactly like
 * the dashboard's SalarySettingsContent. Replacing the map would silently
 * move every other source type back to series A.
 *
 * Field shapes reuse UpdateSettingsSchema (lib/api/schemas.ts) so this REST
 * surface and the internal settings route can never disagree on the allowed
 * values. Deliberately narrow: only the payroll fields. The general
 * /api/v1/companies/{companyId}/settings endpoint owns invoice payment and
 * contact details; tax and legal profile fields are not on the public API.
 */

import { z } from 'zod'
import { SalaryCalculationPolicySchema, type SalaryCalculationPolicy } from '@/lib/salary/calculation-policy'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import {
  resolveDefaultSeriesForSource,
  STANDARD_VOUCHER_SERIES_MAP,
  type VoucherSeriesMap,
} from '@/lib/bookkeeping/voucher-series-resolver'
import type { CompanySettings } from '@/types'

type DeviationPeriod = CompanySettings['salary_deviation_period']
type PaymentFormat = CompanySettings['preferred_payment_format']
type DefaultBank = CompanySettings['salary_default_bank']

/**
 * The columns this endpoint reads and writes. Nullable on the TypeScript
 * side even though the DB columns carry NOT NULL defaults: the resource
 * builder falls back to the same defaults, so a legacy row with a null in it
 * still renders a complete resource.
 */
interface SalarySettingsRow {
  salary_pay_day: number | null
  salary_deviation_period: DeviationPeriod | null
  preferred_payment_format: PaymentFormat | null
  salary_default_bank: DefaultBank | null
  salary_net_rounding: boolean | null
  salary_calculation_policy?: SalaryCalculationPolicy
  default_voucher_series_per_source_type: VoucherSeriesMap | null
}

/**
 * What a company without a settings row gets: the DB column defaults
 * (migrations 20260703190000, 20260813143000, 20260918120000) mirrored here
 * so a fresh company reads sensibly before its first write.
 */
const SALARY_SETTINGS_DEFAULTS = {
  salary_pay_day: 25,
  salary_deviation_period: 'same_month' as DeviationPeriod,
  preferred_payment_format: 'pain001' as PaymentFormat,
  salary_default_bank: null as DefaultBank,
  salary_net_rounding: false,
}

const VOUCHER_SERIES_RE = /^[A-Z]$/

const SalarySettingsResource = z.object({
  company_id: z.string().uuid(),
  salary_pay_day: z.number().int().min(1).max(28),
  salary_deviation_period: z.enum(['same_month', 'previous_month']),
  preferred_payment_format: z.enum(['pain001', 'bg_lb']),
  salary_default_bank: z.enum(['swedbank', 'seb', 'handelsbanken', 'nordea', 'other']).nullable(),
  salary_net_rounding: z.boolean(),
  salary_calculation_policy: SalaryCalculationPolicySchema,
  salary_voucher_series: z.string().regex(VOUCHER_SERIES_RE),
})

type SalarySettingsResourceShape = z.infer<typeof SalarySettingsResource>

// Body schema: strict (unknown keys are rejected, so a typo never passes as a
// no-op), every key optional. The at-least-one-field rule is enforced in the
// handler. Column shapes are the internal settings route's own Zod shapes;
// the voucher series is this endpoint's alias for the per-source-type map.
const V1PatchSalarySettingsSchema = z
  .object({
    salary_pay_day: UpdateSettingsSchema.shape.salary_pay_day,
    salary_deviation_period: UpdateSettingsSchema.shape.salary_deviation_period,
    preferred_payment_format: UpdateSettingsSchema.shape.preferred_payment_format,
    salary_default_bank: UpdateSettingsSchema.shape.salary_default_bank,
    salary_net_rounding: UpdateSettingsSchema.shape.salary_net_rounding,
    salary_calculation_policy: UpdateSettingsSchema.shape.salary_calculation_policy,
    salary_voucher_series: z
      .string()
      .regex(VOUCHER_SERIES_RE, 'Voucher series must be a single uppercase letter A-Z.')
      .optional(),
  })
  .strict()

type V1PatchSalarySettings = z.infer<typeof V1PatchSalarySettingsSchema>

function toSalarySettingsResource(
  companyId: string,
  row: SalarySettingsRow | null,
): SalarySettingsResourceShape {
  return {
    company_id: companyId,
    salary_pay_day: row?.salary_pay_day ?? SALARY_SETTINGS_DEFAULTS.salary_pay_day,
    salary_deviation_period:
      row?.salary_deviation_period ?? SALARY_SETTINGS_DEFAULTS.salary_deviation_period,
    preferred_payment_format:
      row?.preferred_payment_format ?? SALARY_SETTINGS_DEFAULTS.preferred_payment_format,
    salary_default_bank: row?.salary_default_bank ?? SALARY_SETTINGS_DEFAULTS.salary_default_bank,
    salary_net_rounding: row?.salary_net_rounding ?? SALARY_SETTINGS_DEFAULTS.salary_net_rounding,
    salary_calculation_policy: SalaryCalculationPolicySchema.parse(row?.salary_calculation_policy ?? {}),
    // null row => 'A': the same fallback the salary-run engine applies when
    // there is no settings row to read.
    salary_voucher_series: resolveDefaultSeriesForSource(row, 'salary_payment'),
  }
}

/**
 * The per-source-type map after applying a voucher-series change, or
 * undefined when the caller did not touch the series (so the column is left
 * alone by the write). Merges into the current map; for a company without a
 * row the base is the standard set, which is what the DB default would give
 * the inserted row anyway, so the only difference the caller makes is the
 * salary_payment letter.
 */
function nextVoucherSeriesMap(
  current: SalarySettingsRow | null,
  series: string | undefined,
): VoucherSeriesMap | undefined {
  if (series === undefined) return undefined
  const base: VoucherSeriesMap = current
    ? { ...(current.default_voucher_series_per_source_type ?? {}) }
    : { ...STANDARD_VOUCHER_SERIES_MAP }
  return { ...base, salary_payment: series }
}

/** `next` when supplied (explicit null counts as supplied), else `current`, else the default. */
function pick<T>(next: T | undefined, current: T | null | undefined, fallback: T): T {
  if (next !== undefined) return next
  if (current !== undefined && current !== null) return current
  return fallback
}

/**
 * The row as it will read after the write: what the dry-run previews and
 * what a real write is expected to return. For a company without a row, the
 * unspecified columns take the DB defaults, including the standard voucher
 * series set (salary_payment on K) that the insert leaves to the column
 * default.
 */
function mergeSalarySettings(
  current: SalarySettingsRow | null,
  changes: V1PatchSalarySettings,
): SalarySettingsRow {
  const seriesMap = nextVoucherSeriesMap(current, changes.salary_voucher_series)
  return {
    salary_calculation_policy: changes.salary_calculation_policy ?? current?.salary_calculation_policy,
    salary_pay_day: pick(changes.salary_pay_day, current?.salary_pay_day, SALARY_SETTINGS_DEFAULTS.salary_pay_day),
    salary_deviation_period: pick(
      changes.salary_deviation_period,
      current?.salary_deviation_period,
      SALARY_SETTINGS_DEFAULTS.salary_deviation_period,
    ),
    preferred_payment_format: pick(
      changes.preferred_payment_format,
      current?.preferred_payment_format,
      SALARY_SETTINGS_DEFAULTS.preferred_payment_format,
    ),
    salary_default_bank:
      changes.salary_default_bank !== undefined
        ? changes.salary_default_bank
        : (current?.salary_default_bank ?? SALARY_SETTINGS_DEFAULTS.salary_default_bank),
    salary_net_rounding: pick(
      changes.salary_net_rounding,
      current?.salary_net_rounding,
      SALARY_SETTINGS_DEFAULTS.salary_net_rounding,
    ),
    default_voucher_series_per_source_type:
      seriesMap ??
      (current
        ? current.default_voucher_series_per_source_type
        : { ...STANDARD_VOUCHER_SERIES_MAP }),
  }
}

const EXAMPLE_RESOURCE = {
  company_id: 'aaaa1111-2222-4333-8444-555566667777',
  salary_pay_day: 25,
  salary_deviation_period: 'previous_month',
  preferred_payment_format: 'pain001',
  salary_default_bank: 'swedbank',
  salary_net_rounding: true,
  salary_voucher_series: 'K',
}

const SHARED_PITFALLS = [
  'salary_deviation_period is snapshotted onto each salary run at creation: changing it never moves a run that already exists. Set it before the first run of a new month. Switching later makes the next run\'s deviation window overlap the previous run\'s window, and that run is refused with 409 SALARY_RUN_DEVIATION_PERIOD_OVERLAP (pass explicit deviation_period_start/end on that one run to bridge the switch).',
  'salary_pay_day only drives the default payment_date of NEW runs (the day of the pay month, 1-28 so it exists in every month). Existing runs keep their payment_date; override per run on POST /salary-runs.',
  'salary_voucher_series is an alias for company_settings.default_voucher_series_per_source_type.salary_payment. Writes MERGE that one key into the per-source-type map; the other source types keep their letters. The default company layout books salaries on K.',
  'preferred_payment_format: pain001 (ISO 20022) is the default; bg_lb (Bankgirot Leverantörsbetalningar / Lön) is being retired by the banks during 2026, so only pick it for a customer whose bank still accepts LB files.',
]

registerEndpoint({
  operation: 'salary.settings.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary/settings',
  summary: 'Get the company payroll settings.',
  description:
    'Returns the payroll settings that drive new salary runs: pay day (salary_pay_day), avvikelseperiod (salary_deviation_period: which month a run reads absence and worked days from), salary payment file format (preferred_payment_format), the bank whose upload instructions are pre-selected (salary_default_bank), öresavrundning of net pay (salary_net_rounding) and the voucher series salary runs book into (salary_voucher_series). A company that has no settings row yet answers with the defaults the engine would apply (pay day 25, same_month, pain001, no bank, no rounding, series A).',
  useWhen:
    'You are provisioning or auditing a customer for payroll and need to know how new salary runs will be dated, which month their deviations are read from, which payment file the bank expects, or which voucher series the salary vouchers land in.',
  doNotUseFor:
    'Invoice payment and contact details (PATCH /api/v1/companies/{companyId}/settings). Per-run values such as payment_date or deviation window (GET /salary-runs/{id}: they are snapshotted on the run). Employee-level pay settings (GET /employees/{id}).',
  pitfalls: [
    ...SHARED_PITFALLS,
    'A company without a settings row reports series A (the engine fallback). The first PATCH creates the row with the standard series set, where salary_payment is K, unless salary_voucher_series is supplied in that same call: send it explicitly when provisioning so the letter never changes under you.',
  ],
  example: {
    response: {
      data: EXAMPLE_RESOURCE,
      meta: { request_id: 'req_...', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(SalarySettingsResource) },
})

registerEndpoint({
  operation: 'salary.settings.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/salary/settings',
  summary: 'Partially update the company payroll settings.',
  description:
    'Patches the payroll settings: salary_pay_day (1-28), salary_deviation_period (same_month | previous_month), preferred_payment_format (pain001 | bg_lb), salary_default_bank (swedbank | seb | handelsbanken | nordea | other | null), salary_net_rounding (boolean) and salary_voucher_series (one letter A-Z). All fields optional; at least one must be supplied; unknown fields are rejected. Upserts: a company without a settings row gets one created with the supplied values and DB defaults for the rest. Returns the full resource after the write. Idempotent (mandatory Idempotency-Key). Dry-runnable: ?dry_run=true returns the merged resource without writing.',
  useWhen:
    'You are onboarding a customer for payroll over the API (set the pay day, avvikelseperiod, payment file format, bank and voucher series before the first run), or a customer changes bank or pay day.',
  doNotUseFor:
    'Invoice payment and contact details (PATCH /api/v1/companies/{companyId}/settings). Changing the payment date or deviation window of an existing run (PATCH /salary-runs/{id}, or explicit deviation_period_start/end on POST). Tax and legal profile changes (not on the public API).',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'At least one field must be supplied; an empty body returns 400. Unknown fields return 400 (strict body).',
    ...SHARED_PITFALLS,
    'salary_default_bank: null clears the bank; omitting the field leaves it unchanged. The bank only pre-selects upload instructions, it does not change the payment file format.',
  ],
  example: {
    request: {
      salary_pay_day: 25,
      salary_deviation_period: 'previous_month',
      salary_default_bank: 'swedbank',
      salary_net_rounding: true,
      salary_voucher_series: 'K',
    },
    response: {
      data: EXAMPLE_RESOURCE,
      meta: { request_id: 'req_...', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  // Settings only shape future runs; nothing is posted and a second PATCH
  // restores any value.
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: V1PatchSalarySettingsSchema },
  response: { success: dataEnvelope(SalarySettingsResource) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary.settings.get',
  async (_request, ctx) => {
    // Literal projection (not a shared const): the schema guard
    // (tests/schema/no-phantom-columns.test.ts) can only verify columns in
    // inline literals.
    const { data, error } = await ctx.supabase
      .from('company_settings')
      .select('salary_pay_day, salary_deviation_period, preferred_payment_format, salary_default_bank, salary_net_rounding, salary_calculation_policy, default_voucher_series_per_source_type')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    return ok(toSalarySettingsResource(ctx.companyId!, (data as SalarySettingsRow | null) ?? null), {
      requestId: ctx.requestId,
    })
  },
)

export const PATCH = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary.settings.update',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body must be a JSON object.' },
      })
    }

    const parsed = V1PatchSalarySettingsSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const changes = parsed.data

    const suppliedCount = Object.values(changes).filter((value) => value !== undefined).length
    if (suppliedCount === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field must be supplied.' },
      })
    }

    // Read the current row first: the voucher series merges into the
    // existing map, and a missing row switches the write from update to
    // insert. Literal projection for the schema guard (see GET).
    const { data: current, error: fetchErr } = await ctx.supabase
      .from('company_settings')
      .select('salary_pay_day, salary_deviation_period, preferred_payment_format, salary_default_bank, salary_net_rounding, salary_calculation_policy, default_voucher_series_per_source_type')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    const currentRow = (current as SalarySettingsRow | null) ?? null

    if (ctx.dryRun) {
      return dryRunPreview(
        toSalarySettingsResource(ctx.companyId!, mergeSalarySettings(currentRow, changes)),
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Literal payloads (not the parsed object) so the schema guard can
    // statically verify every column name. Fields the caller did not supply
    // are `undefined` and dropped by supabase-js JSON serialization, so only
    // supplied columns are written; explicit null (salary_default_bank)
    // still clears. Shared by the normal update path and the insert-race
    // retry below, so the series map is always merged into the row that is
    // actually there.
    const updateExisting = async (existing: SalarySettingsRow) => {
      const { data, error } = await ctx.supabase
        .from('company_settings')
        .update({
          salary_pay_day: changes.salary_pay_day,
          salary_deviation_period: changes.salary_deviation_period,
          preferred_payment_format: changes.preferred_payment_format,
          salary_default_bank: changes.salary_default_bank,
          salary_net_rounding: changes.salary_net_rounding,
          salary_calculation_policy: changes.salary_calculation_policy,
          default_voucher_series_per_source_type: nextVoucherSeriesMap(existing, changes.salary_voucher_series),
        })
        .eq('company_id', ctx.companyId!)
        .select('salary_pay_day, salary_deviation_period, preferred_payment_format, salary_default_bank, salary_net_rounding, salary_calculation_policy, default_voucher_series_per_source_type')
        .maybeSingle()

      if (error) {
        return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
      }
      if (!data) {
        // The row was there a moment ago; a concurrent delete is the only
        // way here. Same answer as the general settings endpoint.
        ctx.log.warn('salary.settings.update: settings row vanished before write', {
          companyId: ctx.companyId,
        })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'company_settings' },
        })
      }

      return ok(toSalarySettingsResource(ctx.companyId!, data as SalarySettingsRow), {
        requestId: ctx.requestId,
      })
    }

    if (currentRow) {
      return updateExisting(currentRow)
    }

    const seriesMap = nextVoucherSeriesMap(currentRow, changes.salary_voucher_series)

    // No row yet (fresh company): create it. Unspecified columns take the DB
    // defaults, the same values GET reported before this call, except the
    // voucher series map, which the column default sets to the standard
    // layout (salary_payment on K); see the pitfalls.
    const { data, error } = await ctx.supabase
      .from('company_settings')
      .insert({
        company_id: ctx.companyId!,
        user_id: ctx.userId,
        salary_pay_day: changes.salary_pay_day,
        salary_deviation_period: changes.salary_deviation_period,
        preferred_payment_format: changes.preferred_payment_format,
        salary_default_bank: changes.salary_default_bank,
        salary_net_rounding: changes.salary_net_rounding,
        salary_calculation_policy: changes.salary_calculation_policy,
        default_voucher_series_per_source_type: seriesMap,
      })
      .select('salary_pay_day, salary_deviation_period, preferred_payment_format, salary_default_bank, salary_net_rounding, salary_calculation_policy, default_voucher_series_per_source_type')
      .maybeSingle()

    if (error) {
      // company_id is unique on company_settings. Two concurrent PATCHes on
      // a fresh company both see no row; the loser's insert lands on 23505.
      // Its changes are still valid: re-read the winner's row and apply them
      // as an update instead of answering 400 to a correct request.
      if ((error as { code?: string }).code === '23505') {
        const { data: raced, error: racedErr } = await ctx.supabase
          .from('company_settings')
          .select('salary_pay_day, salary_deviation_period, preferred_payment_format, salary_default_bank, salary_net_rounding, salary_calculation_policy, default_voucher_series_per_source_type')
          .eq('company_id', ctx.companyId!)
          .maybeSingle()
        if (racedErr) {
          return v1ErrorResponse(racedErr, ctx.log, { requestId: ctx.requestId })
        }
        if (raced) {
          ctx.log.info('salary.settings.update: insert raced an existing row, applying as update', {
            companyId: ctx.companyId,
          })
          return updateExisting(raced as SalarySettingsRow)
        }
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    ctx.log.info('salary.settings.update: created company_settings row', {
      companyId: ctx.companyId,
    })

    // A missing row after an insert cannot happen with PostgREST's returning
    // representation; fall back to the merged view rather than fail.
    return ok(
      toSalarySettingsResource(
        ctx.companyId!,
        (data as SalarySettingsRow | null) ?? mergeSalarySettings(null, changes),
      ),
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
