/**
 * The K3 operations (BFNAR 2012:1; the K3 plan's phase 2, accounted#111):
 * one definition each behind v1, the staged MCP tool and the approval path,
 * over the same services the dashboard routes call.
 *
 *   - assets.value-adjustments.create: nedskrivning or its reversal (ÅRL
 *     4:5, K3 27), lib/bokslut/assets/value-adjustment-service.ts;
 *   - assets.components.replace: a K3 component replaced (17.5, 17.21A),
 *     component-service.ts;
 *   - assets.tax-plan.set: a building's tax depreciation plan (IL 19-20
 *     kap., INK2S 4.9), building-tax-service.ts;
 *   - assets.transition-split.set: an asset split on components at the
 *     transition to K3 (35.18), transition-split-service.ts;
 *   - deferred-tax.set: the uppskjuten skatt inputs of a K3
 *     year (29.29, manual differences), deferred-tax-service.ts;
 *   - accounting-policies.update: the 18.7 model, development-model.ts
 *     (owners and admins, as the dashboard);
 *   - k3-transition.get / .start / .update / .delete / .commit: the
 *     transition to K3 (kap. 35), k3-transition/transition-service.ts.
 *
 * Every write books through the services (the posting port), never here.
 */
import { z } from 'zod'
import {
  ReplaceComponentSchema,
  replacementPreviewView,
  ValueAdjustmentSchema,
  valueAdjustmentPreviewView,
} from '@/lib/bokslut/assets/asset-api'
import { setAssetTaxPlan, TaxPlanSchema } from '@/lib/bokslut/assets/building-tax-service'
import { previewComponentReplacement, replaceAssetComponent } from '@/lib/bokslut/assets/component-service'
import { DevelopmentModelSchema, setDevelopmentModel } from '@/lib/bokslut/assets/development-model'
import { splitAssetAtTransition, TransitionSplitSchema } from '@/lib/bokslut/assets/transition-split-service'
import { postValueAdjustment, previewValueAdjustment } from '@/lib/bokslut/assets/value-adjustment-service'
import {
  checkDeleteK3Transition,
  checkStartK3Transition,
  checkUpdateK3Transition,
  commitK3TransitionPosting,
  deleteK3Transition,
  getK3Transition,
  K3TransitionPostingSchema,
  k3TransitionYear,
  previewK3Transition,
  startK3Transition,
  StartK3TransitionSchema,
  updateK3Transition,
  UpdateK3TransitionSchema,
  type K3TransitionState,
} from '@/lib/bokslut/k3-transition/transition-service'
import {
  DeferredTaxAssessmentFields,
  requireLossReason,
  saveDeferredTaxAssessment,
} from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { requireCompanyAdmin } from './access'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const V = '/api/v1/companies/:companyId'

const VoucherLine = z.object({
  account_number: z.string(),
  debit: z.number(),
  credit: z.number(),
  description: z.string().nullable(),
})

// ── Assets ─────────────────────────────────────────────────────────────────

export const assetsValueAdjustmentsCreate = defineOperation({
  id: 'assets.value-adjustments.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  // Books 77xx against 12x8 on the balansdag; undone only by a storno.
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Write an asset down to its recoverable amount (nedskrivning), or reverse an earlier write-down, on a balansdag.',
    description:
      'ÅRL 4 kap. 5 §, K3 kapitel 27 (K2 10.25-10.27 for a K2 company). The test is made on the fiscal year\'s last day after the year\'s planenlig avskrivning: the write-down is the carrying amount less the recoverable amount (the higher of fair value less costs to sell and value in use, K3 27.5); a reversal brings the carrying amount back up, at most to what an unimpaired plan would show (27.15), never for goodwill. One voucher (77xx against the accumulated impairment account 12x8) and the register rows in one transaction; a K3 component asset spreads it over its components by carrying amount. Later years plan from the written-down value. Dry-runnable.',
    useWhen: 'An asset\'s value has fallen materially and lastingly below its carrying amount (K3 27.4 indications), or a write-down made earlier no longer holds.',
    doNotUseFor: 'Planenlig avskrivning (post the annual depreciation), a disposal or scrapping (dispose the asset), or uppskrivning (not supported).',
    pitfalls: [
      'The year\'s depreciation must be posted first: 409 ASSET_VALUE_ADJUSTMENT_BLOCKED (year_not_depreciated).',
      'Only on the balansdag of an open year, and never behind later depreciation or a later write-down.',
      'A goodwill write-down is never reversed (ÅRL 4:5).',
    ],
    example: {
      request: { kind: 'impairment', fiscal_period_id: '0c1e…', recoverable_amount: 400000, reason: 'Marknadsvärdet har fallit (K3 27.4).' },
      response: { data: { asset_id: '7d1e…', journal_entry_id: 'c41d…', amount: 120000 }, meta: META },
    },
  },
  input: z.object({
    asset_id: z.string().uuid().describe('The asset, from gnubok_list_assets.'),
    ...ValueAdjustmentSchema.shape,
  }),
  output: z.object({ asset_id: z.string(), journal_entry_id: z.string(), amount: z.number() }),
  errorCodes: ['ASSET_NOT_FOUND', 'ASSET_VALUE_ADJUSTMENT_BLOCKED', 'PERIOD_LOCKED'],
  http: { method: 'POST', path: `${V}/assets/:id/value-adjustments`, pathParams: { id: 'asset_id' } },
  mcp: {
    name: 'gnubok_post_asset_value_adjustment',
    title: 'Post Asset Write-Down (Nedskrivning)',
    description:
      'Stage a nedskrivning of an asset to its recoverable amount on a balansdag, or a reversal of an earlier one (ÅRL 4:5, K3 27): 77xx against 12x8. Post the year\'s depreciation first.',
    keywords: ['nedskrivning', 'återföring av nedskrivning', 'återvinningsvärde', 'värdenedgång', 'impairment'],
    stage: {
      pendingType: 'post_asset_value_adjustment',
      title: (input) => (input.kind === 'impairment_reversal' ? 'Återför nedskrivning' : 'Bokför nedskrivning'),
    },
  },
  run: async (ctx, { asset_id, ...input }, { dryRun }) => {
    if (dryRun) {
      const preview = await previewValueAdjustment(ctx.supabase, ctx.companyId, asset_id, input)
      return { ok: true, dryRun: true, preview: valueAdjustmentPreviewView(preview) }
    }
    const result = await postValueAdjustment(ctx.supabase, ctx.companyId, ctx.userId, asset_id, input)
    return { ok: true, data: { asset_id, journal_entry_id: result.entry.id, amount: result.preview.amount } }
  },
})

export const assetsComponentsReplace = defineOperation({
  id: 'assets.components.replace',
  kind: 'write',
  scope: 'bookkeeping:write',
  // Books the replaced component off; undone only by a storno.
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Replace a K3 component: take the replaced part off the books and register the replacing one.',
    description:
      'K3 17.5 and 17.21A. One voucher charges the replaced component\'s depreciation to the replacement date, clears its accumulated depreciation and cost, and books what is left as a loss; the replacing component is registered with no voucher (its expenditure is already on the asset account). Omit new_component to derecognise only (a part scrapped without a replacement). Dry-runnable.',
    useWhen: 'A significant part of a K3 component asset is replaced (a new roof, an engine) or scrapped.',
    doNotUseFor: 'A repair (expense it), a new part added without anything replaced (add a component), or a K2 asset.',
    pitfalls: [
      'The component must be active, with no write-down outstanding, and no depreciation posted after the replacement year.',
      'Earlier years\' depreciation must be posted: 409 ASSET_COMPONENT_REPLACEMENT_BLOCKED (earlier_year_unposted).',
    ],
    example: {
      request: { replaced_at: '2026-06-30', fiscal_period_id: '0c1e…', new_component: { name: 'Nytt tak', cost: 400000, useful_life_months: 360 } },
      response: { data: { asset_id: '7d1e…', journal_entry_id: 'c41d…', new_component_id: '5a2c…' }, meta: META },
    },
  },
  input: z.object({
    asset_id: z.string().uuid().describe('The asset, from gnubok_list_assets.'),
    component_id: z.string().uuid().describe('The component replaced (k3_components[].component_id).'),
    ...ReplaceComponentSchema.shape,
  }),
  output: z.object({ asset_id: z.string(), journal_entry_id: z.string(), new_component_id: z.string().nullable() }),
  errorCodes: ['ASSET_NOT_FOUND', 'ASSET_COMPONENT_NOT_FOUND', 'ASSET_COMPONENT_REPLACEMENT_BLOCKED', 'INVALID_K3_COMPONENTS'],
  http: {
    method: 'POST',
    path: `${V}/assets/:id/components/:componentId/replace`,
    pathParams: { id: 'asset_id', componentId: 'component_id' },
  },
  mcp: {
    name: 'gnubok_replace_asset_component',
    title: 'Replace Asset Component',
    description:
      'Stage the replacement of a K3 component (K3 17.5, 17.21A): its depreciation to date, accumulated depreciation and cost off the books, the rest as a loss, and the replacing component registered.',
    keywords: ['komponentbyte', 'utbyte av komponent', 'komponentavskrivning', 'utrangering av komponent'],
    stage: { pendingType: 'replace_asset_component', title: () => 'Byt ut komponent' },
  },
  run: async (ctx, { asset_id, component_id, ...input }, { dryRun }) => {
    if (dryRun) {
      const preview = await previewComponentReplacement(ctx.supabase, ctx.companyId, asset_id, component_id, input)
      return { ok: true, dryRun: true, preview: replacementPreviewView(preview) }
    }
    const result = await replaceAssetComponent(ctx.supabase, ctx.companyId, ctx.userId, asset_id, component_id, input)
    return {
      ok: true,
      data: { asset_id, journal_entry_id: result.entry.id, new_component_id: result.newComponentId ?? null },
    }
  },
})

const TaxPlanView = z.object({
  asset_id: z.string(),
  tax_depreciation_rate: z.number().nullable(),
  tax_depreciation_from: z.string().nullable(),
  tax_primary_allowance: z.boolean(),
})

function taxPlanView(asset: {
  id: string
  tax_depreciation_rate?: number | string | null
  tax_depreciation_from?: string | null
  tax_primary_allowance?: boolean | null
}): z.infer<typeof TaxPlanView> {
  const rate = asset.tax_depreciation_rate
  return {
    asset_id: asset.id,
    tax_depreciation_rate: rate === null || rate === undefined ? null : Number(rate),
    tax_depreciation_from: asset.tax_depreciation_from ?? null,
    tax_primary_allowance: asset.tax_primary_allowance === true,
  }
}

export const assetsTaxPlanSet = defineOperation({
  id: 'assets.tax-plan.set',
  kind: 'write',
  scope: 'bookkeeping:write',
  // No verifikat: moves INK2S 4.9 and the deferred tax of open years.
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'State the tax depreciation plan of a building or markanläggning: percent a year, the day it starts, the primäravdrag.',
    description:
      'IL 19 kap. 5 § (buildings: a percentage a year of the acquisition value set by the economic life, from completion or acquisition), 5 a § (primäravdrag, two percentage points a year for six years on a new, extended or rebuilt hyreshus) and 20 kap. 5 § (markanläggningar: at most 5 %, 10 % for täckdiken and skogsvägar). The plan drives INK2S punkt 4.9 (the book depreciation added back, the tax plan deducted) and, under K3, the deferred tax on the building, for the fiscal years still open when it is stated. A null rate clears it. No verifikat. Dry-runnable.',
    useWhen: 'A building or markanläggning is registered, or its tax depreciation rate is known or changes.',
    doNotUseFor: 'Machinery and equipment (räkenskapsenlig avskrivning, IL 18 kap.) or the book depreciation plan (update the asset).',
    pitfalls: [
      'Only buildings and markanläggningar; mark is never depreciated: 400 INVALID_TAX_PLAN.',
      'A markanläggning takes at most 10 %, the primäravdrag only a building.',
      'The plan reaches only fiscal years still open when it is stated, so a declared INK2 never moves; once a year it reached is closed or locked, it cannot be changed or cleared: 409 TAX_PLAN_USED_BY_CLOSED_YEAR.',
    ],
    example: {
      request: { tax_depreciation_rate: 2, tax_depreciation_from: '2020-01-01', tax_primary_allowance: false },
      response: { data: { asset_id: '7d1e…', tax_depreciation_rate: 2, tax_depreciation_from: '2020-01-01', tax_primary_allowance: false }, meta: META },
    },
  },
  input: z.object({ asset_id: z.string().uuid().describe('The building or markanläggning.'), ...TaxPlanSchema.shape }),
  output: TaxPlanView,
  errorCodes: ['ASSET_NOT_FOUND', 'INVALID_TAX_PLAN', 'TAX_PLAN_USED_BY_CLOSED_YEAR'],
  http: { method: 'PUT', path: `${V}/assets/:id/tax-plan`, pathParams: { id: 'asset_id' } },
  mcp: {
    name: 'gnubok_set_asset_tax_plan',
    title: 'Set Building Tax Depreciation Plan',
    description:
      'Stage a building\'s or markanläggning\'s tax depreciation plan (IL 19-20 kap.): percent a year, start date, primäravdrag. Drives INK2S 4.9 and K3 deferred tax; no verifikat.',
    keywords: ['värdeminskningsavdrag byggnad', 'skattemässig avskrivning', 'primäravdrag', 'markanläggning', 'ink2s 4.9'],
    stage: { pendingType: 'set_asset_tax_plan', title: () => 'Ange skattemässig avskrivningsplan' },
  },
  run: async (ctx, { asset_id, ...input }, { dryRun }) => {
    const asset = await setAssetTaxPlan(ctx.supabase, ctx.companyId, asset_id, input, { dryRun })
    const view = taxPlanView(asset)
    return dryRun ? { ok: true, dryRun: true, preview: view } : { ok: true, data: view }
  },
})

const TransitionSplitComponent = z.object({
  name: z.string(),
  cost: z.number(),
  useful_life_months: z.number().nullable(),
  salvage_value: z.number(),
  opening_accumulated_depreciation: z.number(),
})

export const assetsTransitionSplitSet = defineOperation({
  id: 'assets.transition-split.set',
  kind: 'write',
  scope: 'bookkeeping:write',
  // No verifikat, but it sets the basis every later K3 depreciation plans from.
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Split an asset on significant components at the transition to K3 (35.18), or undo the split.',
    description:
      'K3 punkt 35.18: the carrying amount of a tangible asset at the transition date is divided on its significant components; earlier years are not restated. Give each component its carrying amount at the transition and its total useful life counted from when the asset was first used (null for mark). The accumulated depreciation at the transition is carried into the component openings, so nothing is booked and the components continue prospectively. An empty list undoes the split while nothing is posted per component. Needs the transition started (k3-transition.start). Dry-runnable.',
    useWhen: 'In the first K3 year after K2, for each asset whose significant parts have materially different useful lives (a building\'s stomme, tak, installationer).',
    doNotUseFor: 'An asset acquired under K3 (register its components when creating it) or replacing a part later (assets.components.replace).',
    pitfalls: [
      'The carrying amounts must add up to the asset\'s carrying amount at the transition: 400 INVALID_K3_COMPONENTS.',
      'Depreciation posted from the transition date blocks the split: reverse it first (409 K3_TRANSITION_BLOCKED).',
      'Each useful life is the total life from first use and must be longer than the months already used.',
    ],
    example: {
      request: { components: [{ name: 'Stomme', carrying_amount: 600000, useful_life_months: 1200 }, { name: 'Tak', carrying_amount: 280000, useful_life_months: 480 }] },
      response: { data: { asset_id: '7d1e…', transition_date: '2026-01-01', components: [] }, meta: META },
    },
  },
  input: z.object({ asset_id: z.string().uuid().describe('The asset, from gnubok_get_k3_transition assets[].'), ...TransitionSplitSchema.shape }),
  output: z.object({ asset_id: z.string(), transition_date: z.string(), components: z.array(TransitionSplitComponent) }),
  errorCodes: ['ASSET_NOT_FOUND', 'INVALID_K3_COMPONENTS', 'K3_TRANSITION_BLOCKED'],
  http: { method: 'PUT', path: `${V}/assets/:id/transition-split`, pathParams: { id: 'asset_id' } },
  mcp: {
    name: 'gnubok_split_asset_at_k3_transition',
    title: 'Split Asset at K3 Transition',
    description:
      'Stage the split of an asset on components at the transition to K3 (35.18): each component\'s carrying amount and total useful life. Books nothing; an empty list undoes it. Start the transition first.',
    keywords: ['övergång till k3', 'komponentuppdelning', 'komponentavskrivning', 'ingångsbalansräkning', 'k3 35.18'],
    stage: { pendingType: 'set_asset_transition_split', title: () => 'Dela upp tillgång vid övergången till K3' },
  },
  run: async (ctx, { asset_id, ...request }, { dryRun }) => {
    const plan = await splitAssetAtTransition(ctx.supabase, ctx.companyId, asset_id, request, { dryRun: true })
    if (dryRun) return { ok: true, dryRun: true, preview: { ...plan } }
    await splitAssetAtTransition(ctx.supabase, ctx.companyId, asset_id, request)
    return { ok: true, data: plan }
  },
})

// ── Deferred tax inputs ──────────────────────────────────────────────────

export const fiscalPeriodsDeferredTaxSet = defineOperation({
  id: 'deferred-tax.set',
  kind: 'write',
  scope: 'bookkeeping:write',
  // Inputs only: the deferred tax is posted with the year-end dispositions.
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Save the uppskjuten skatt inputs of a K3 year: whether the tax loss carried forward is recognised and why, and differences entered by hand.',
    description:
      'K3 kapitel 29. The register computes the buildings\' differences itself (their tax plan against the carrying amount); this saves what it cannot know: the 29.29 judgement that a tax loss carried forward will be used (recognised only with the reason written down), and temporary differences entered by hand (an item whose carrying amount and tax value differ, e.g. a provision deductible when paid). Untaxed reserves stay gross (29.37) and are never entered. The deferred tax is posted with the year-end dispositions (uppskjuten_skatt_kap29). K3 years only. Dry-runnable.',
    useWhen: 'Before posting the year-end dispositions of a K3 year with a tax loss or a temporary difference the register does not compute.',
    doNotUseFor: 'K2 years (no deferred tax) or obeskattade reserver.',
    pitfalls: [
      'loss_recognised needs loss_reason (29.29): 400 VALIDATION_ERROR.',
      'K2 years answer 422 DEFERRED_TAX_NOT_APPLICABLE; a locked or closed year 409 PERIOD_LOCKED.',
    ],
    example: {
      request: { loss_recognised: true, loss_reason: 'Avtal ger vinst 2027.', manual_items: [] },
      response: { data: { fiscal_period_id: '0c1e…', loss_recognised: true, loss_reason: 'Avtal ger vinst 2027.', manual_items: [] }, meta: META },
    },
  },
  input: z
    .object({
      fiscal_period_id: z.string().uuid().describe('The K3 fiscal year.'),
      ...DeferredTaxAssessmentFields.shape,
    })
    .superRefine(requireLossReason),
  output: z.object({
    fiscal_period_id: z.string(),
    loss_recognised: z.boolean(),
    loss_reason: z.string().nullable(),
    manual_items: z.array(z.object({ label: z.string(), nature: z.string(), carrying_amount: z.number(), tax_value: z.number() })),
  }),
  errorCodes: ['PERIOD_NOT_FOUND', 'PERIOD_LOCKED', 'DEFERRED_TAX_NOT_APPLICABLE'],
  http: { method: 'PUT', path: `${V}/fiscal-periods/:id/deferred-tax`, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_set_deferred_tax_inputs',
    title: 'Set Deferred Tax Inputs (K3)',
    description:
      'Stage a K3 year\'s uppskjuten skatt inputs: whether the tax loss carried forward is recognised (with the 29.29 reason) and temporary differences entered by hand. Posted with the year-end dispositions.',
    keywords: ['uppskjuten skatt', 'temporär skillnad', 'underskottsavdrag', 'k3 kapitel 29', 'deferred tax'],
    stage: { pendingType: 'save_deferred_tax_inputs', title: () => 'Spara underlag för uppskjuten skatt' },
  },
  run: async (ctx, { fiscal_period_id, ...input }, { dryRun }) => {
    const saved = await saveDeferredTaxAssessment(ctx.supabase, ctx.companyId, ctx.userId, fiscal_period_id, input, { dryRun })
    const view = { fiscal_period_id, ...saved }
    return dryRun ? { ok: true, dryRun: true, preview: view } : { ok: true, data: view }
  },
})

// ── Accounting policies ─────────────────────────────────────────────────

export const companyAccountingPoliciesUpdate = defineOperation({
  id: 'accounting-policies.update',
  kind: 'write',
  scope: 'companies:write',
  // An accounting policy: decides whether own development is capitalised.
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Choose the K3 model for internally generated intangible assets: expense or capitalise (punkt 18.7).',
    description:
      'K3 punkt 18.7: a company applies either the kostnadsföringsmodell (expense) or the aktiveringsmodell (capitalise) to all its own development. Only the aktiveringsmodell lets own development be capitalised on 1010/1019, and a capitalised amount is moved to the fond för utvecklingsutgifter at year-end (ÅRL 4:2). K3 companies only. Switching away from capitalise while capitalised own development is on the register is a change of accounting policy (K3 kap. 10) and is refused. Owners and admins only. Dry-runnable.',
    useWhen: 'A K3 company starts capitalising own development, or states that it expenses it.',
    doNotUseFor: 'Purchased intangibles (always capitalised on 1090/1099) or K2 companies (own development is always expensed).',
    pitfalls: ['422 DEVELOPMENT_MODEL_REFUSED for a K2 company or a switch away from capitalise with own development capitalised.', '403 FORBIDDEN for a member who is not an owner or admin.'],
    example: {
      request: { development_expenditure_model: 'capitalise' },
      response: { data: { development_expenditure_model: 'capitalise' }, meta: META },
    },
  },
  input: DevelopmentModelSchema,
  output: z.object({ development_expenditure_model: z.enum(['expense', 'capitalise']) }),
  errorCodes: ['DEVELOPMENT_MODEL_REFUSED', 'FORBIDDEN'],
  http: { method: 'PATCH', path: `${V}/accounting-policies` },
  mcp: {
    name: 'gnubok_set_development_model',
    title: 'Set Development Expenditure Model (K3)',
    description:
      'Stage the K3 18.7 model for own development: expense or capitalise. Capitalise allows 1010/1019 and the fond för utvecklingsutgifter. Owners and admins; K3 only.',
    keywords: ['aktiveringsmodellen', 'kostnadsföringsmodellen', 'egen utveckling', 'fond för utvecklingsutgifter', 'k3 18.7'],
    stage: { pendingType: 'update_accounting_policies', title: () => 'Ändra redovisningsprincip för egen utveckling' },
  },
  run: async (ctx, input, { dryRun }) => {
    const refused = await requireCompanyAdmin(ctx, 'Bara ägare och administratörer kan ändra redovisningsprinciperna.')
    if (refused) return refused
    const model = await setDevelopmentModel(ctx.supabase, ctx.companyId, input.development_expenditure_model, {
      dryRun,
      userId: ctx.userId,
    })
    const view = { development_expenditure_model: model }
    return dryRun ? { ok: true, dryRun: true, preview: view } : { ok: true, data: view }
  },
})

// ── The transition to K3 ─────────────────────────────────────────────────

const TransitionView = z.object({
  transition: z
    .object({
      k3_transition_id: z.string(),
      fiscal_period_id: z.string(),
      deferred_tax_relief: z.boolean(),
      relief_rules: z.array(z.string()),
      changed_principles: z.string(),
      journal_entry_id: z.string().nullable(),
      opening_deferred_tax: z.number(),
      committed_at: z.string().nullable(),
    })
    .nullable(),
  committed: z.boolean(),
  transition_date: z.string().nullable(),
  year: z
    .object({
      fiscal_period_id: z.string(),
      framework: z.enum(['k2', 'k3']),
      framework_source: z.string(),
      framework_confirmed: z.boolean(),
      open: z.boolean(),
    })
    .nullable(),
  assets: z.array(
    z.object({
      asset_id: z.string(),
      name: z.string(),
      status: z.string(),
      cost: z.number(),
      accumulated: z.number(),
      carrying_amount: z.number(),
      months_used: z.number(),
    }),
  ),
})

function transitionView(state: K3TransitionState, year: z.infer<typeof TransitionView>['year']): z.infer<typeof TransitionView> {
  const row = state.transition
  return {
    transition: row
      ? {
          k3_transition_id: row.id,
          fiscal_period_id: row.fiscal_period_id,
          deferred_tax_relief: row.deferred_tax_relief,
          relief_rules: row.relief_rules,
          changed_principles: row.changed_principles,
          journal_entry_id: row.journal_entry_id,
          opening_deferred_tax: row.opening_deferred_tax,
          committed_at: row.committed_at,
        }
      : null,
    committed: state.committed,
    transition_date: state.period?.period_start ?? null,
    year,
    assets: state.assets.map((asset) => ({
      asset_id: asset.asset_id,
      name: asset.name,
      status: asset.status,
      cost: asset.cost,
      accumulated: asset.accumulated,
      carrying_amount: asset.carrying_amount,
      months_used: asset.months_used,
    })),
  }
}

export const k3TransitionGet = defineOperation({
  id: 'k3-transition.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Read the company\'s transition to K3 (kap. 35): the first K3 year, the relief chosen, the note facts, and the assets the 35.18 split concerns.',
    description:
      'transition is null until it is started. committed is true once the transition voucher is posted (or the transition was committed with nothing to book); a storno of the voucher opens it again. assets lists the tangible assets from before the transition date with their carrying amount at the transition and their split status (plain, split, components, later_depreciation_posted). With fiscal_period_id, year answers that year\'s framework.',
    useWhen: 'Before the first K3 year-end after K2, or to check whether the transition is done before the årsredovisning.',
    doNotUseFor: 'The K2/K3 choice itself (company settings) or the årsredovisning\'s notes.',
    pitfalls: ['Only the mindre företag route is supported: the transition date is the first day of the first K3 year and comparatives are not restated.'],
    example: {
      response: {
        data: { transition: null, committed: false, transition_date: null, year: null, assets: [] },
        meta: META,
      },
    },
  },
  input: z.object({ fiscal_period_id: z.string().uuid().optional().describe('A fiscal year whose framework to answer as year.') }),
  output: TransitionView,
  http: { method: 'GET', path: `${V}/k3-transition` },
  mcp: {
    name: 'gnubok_get_k3_transition',
    title: 'Get K3 Transition',
    description:
      'Read the transition to K3 (kap. 35): first K3 year, 35.27 relief, relief rules and changed principles, whether it is posted, and the assets the 35.18 component split concerns.',
    keywords: ['övergång till k3', 'k3 kapitel 35', 'förstagångstillämpning', 'ingångsbalansräkning', 'k2 till k3'],
  },
  run: async (ctx, input) => {
    const [state, year] = await Promise.all([
      getK3Transition(ctx.supabase, ctx.companyId),
      input.fiscal_period_id ? k3TransitionYear(ctx.supabase, ctx.companyId, input.fiscal_period_id) : null,
    ])
    return { ok: true, data: transitionView(state, year) }
  },
})

async function readView(ctx: { supabase: Parameters<typeof getK3Transition>[0]; companyId: string }) {
  return transitionView(await getK3Transition(ctx.supabase, ctx.companyId), null)
}

export const k3TransitionStart = defineOperation({
  id: 'k3-transition.start',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Start the transition to K3 on the first K3 fiscal year (an open year reported under K3).',
    description:
      'K3 kapitel 35, once per company (35.1). The transition date is the first day of that year (35.7 andra stycket: a mindre företag that does not restate its comparatives). Nothing is booked: the component split (assets.transition-split.set), the relief choice and note facts (k3-transition.update) and the commit (k3-transition.commit) follow. Dry-runnable.',
    useWhen: 'A company that prepared its earlier årsredovisningar under K2 closes its first K3 year.',
    doNotUseFor: 'A new company whose first year is K3 (no earlier financial report: nothing to transition).',
    pitfalls: ['The year must be open and reported under K3: 409 K3_TRANSITION_BLOCKED (not_k3, period_locked, already_started).'],
    example: {
      request: { fiscal_period_id: '0c1e…' },
      response: { data: { transition: { k3_transition_id: '9f3b…' }, committed: false }, meta: META },
    },
  },
  input: StartK3TransitionSchema,
  output: TransitionView,
  errorCodes: ['PERIOD_NOT_FOUND', 'K3_TRANSITION_BLOCKED'],
  http: { method: 'POST', path: `${V}/k3-transition` },
  mcp: {
    name: 'gnubok_start_k3_transition',
    title: 'Start K3 Transition',
    description:
      'Stage the start of the transition to K3 (kap. 35) on the first K3 fiscal year; its first day is the transition date. Nothing is booked until gnubok_commit_k3_transition.',
    keywords: ['övergång till k3', 'k3 kapitel 35', 'k2 till k3', 'förstagångstillämpare'],
    stage: { pendingType: 'start_k3_transition', title: () => 'Påbörja övergången till K3' },
  },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) {
      const plan = await checkStartK3Transition(ctx.supabase, ctx.companyId, input)
      return { ok: true, dryRun: true, preview: plan }
    }
    await startK3Transition(ctx.supabase, ctx.companyId, ctx.userId, input)
    return { ok: true, data: await readView(ctx), created: true }
  },
})

export const k3TransitionUpdate = defineOperation({
  id: 'k3-transition.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Set the transition\'s 35.27 relief and the facts its notes state: the relief rules applied (35.31) and the principles changed (35.33).',
    description:
      'deferred_tax_relief true: no deferred tax in the opening balance (35.27, only when the information cannot be produced without unreasonable cost); it is fixed once the transition is committed. relief_rules are the other relief rules applied (35.21-35.26, 35.28, 35.29, 35.34); changed_principles describes the accounting principles changed at the transition. The notes stay editable after the commit. Dry-runnable.',
    useWhen: 'While preparing the first K3 year, before the commit and the årsredovisning.',
    doNotUseFor: 'Booking anything (k3-transition.commit).',
    pitfalls: ['The relief cannot change once the transition is committed: reverse the voucher first.'],
    example: {
      request: { deferred_tax_relief: false, relief_rules: ['35.22'], changed_principles: 'Byggnader skrivs av per komponent (K3 17.4).' },
      response: { data: { transition: { k3_transition_id: '9f3b…', relief_rules: ['35.22'] }, committed: false }, meta: META },
    },
  },
  input: UpdateK3TransitionSchema,
  output: TransitionView,
  errorCodes: ['K3_TRANSITION_BLOCKED'],
  http: { method: 'PATCH', path: `${V}/k3-transition` },
  mcp: {
    name: 'gnubok_update_k3_transition',
    title: 'Update K3 Transition',
    description:
      'Stage the K3 transition\'s 35.27 relief choice, the relief rules applied (35.31) and the accounting principles changed (35.33).',
    keywords: ['övergång till k3', 'lättnadsregler', 'k3 35.27', 'ändrade redovisningsprinciper', 'k3 35.33'],
    stage: { pendingType: 'update_k3_transition', title: () => 'Ändra övergången till K3' },
  },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) {
      const plan = await checkUpdateK3Transition(ctx.supabase, ctx.companyId, input)
      return { ok: true, dryRun: true, preview: plan }
    }
    await updateK3Transition(ctx.supabase, ctx.companyId, input)
    return { ok: true, data: await readView(ctx) }
  },
})

export const k3TransitionDelete = defineOperation({
  id: 'k3-transition.delete',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Drop a transition to K3 that is not committed and has no component splits left.',
    description: 'Undoes k3-transition.start. Refused once committed (reverse the voucher first) or while assets are split at it (undo each split first). Dry-runnable.',
    useWhen: 'The transition was started on the wrong year, or the company was on K3 all along.',
    doNotUseFor: 'Undoing a posted transition (storno the transition voucher).',
    pitfalls: ['409 K3_TRANSITION_BLOCKED (committed, has_splits).'],
    example: { response: { data: { k3_transition_id: '9f3b…', deleted: true }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ k3_transition_id: z.string(), deleted: z.boolean() }),
  errorCodes: ['K3_TRANSITION_BLOCKED'],
  http: { method: 'DELETE', path: `${V}/k3-transition` },
  mcp: {
    name: 'gnubok_delete_k3_transition',
    title: 'Delete K3 Transition',
    description: 'Stage dropping an uncommitted transition to K3 that has no component splits left.',
    keywords: ['övergång till k3', 'ta bort övergång'],
    stage: { pendingType: 'delete_k3_transition', title: () => 'Ta bort övergången till K3' },
  },
  run: async (ctx, _input, { dryRun }) => {
    const plan = await checkDeleteK3Transition(ctx.supabase, ctx.companyId)
    if (dryRun) return { ok: true, dryRun: true, preview: { ...plan, deleted: true } }
    await deleteK3Transition(ctx.supabase, ctx.companyId)
    return { ok: true, data: { ...plan, deleted: true } }
  },
})

export const k3TransitionCommit = defineOperation({
  id: 'k3-transition.commit',
  kind: 'write',
  scope: 'bookkeeping:write',
  // Posts the transition voucher; undone only by a storno.
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Post the transition to K3: the opening deferred tax and the stated adjustments against equity on the first day of the first K3 year.',
    description:
      'K3 punkt 35.11. One system voucher dated the transition date: the opening deferred tax (the buildings on their tax plan at the day before, a tax loss brought in with its 29.29 reason, differences entered by hand; net on 2240 or 1370, 29.32) unless the 35.27 relief is chosen, and each stated adjustment (a balance sheet account and amount, + debit / - credit) against balanserat resultat. Locked and closed years are never touched. Nothing to book commits without a voucher. The dry run answers the voucher lines. A storno of the voucher opens the transition again.',
    useWhen: 'After the component splits and the relief choice, before the first K3 year-end.',
    doNotUseFor: 'Year-end deferred tax (posted with the dispositions) or corrections of earlier years (rättelse of fel, K3 kap. 10).',
    pitfalls: [
      'Adjustments only on balance sheet accounts outside equity and 2240/1370: 400 INVALID_K3_TRANSITION.',
      'loss_carryforward needs the reason that convincingly supports its use (29.29).',
      'Once committed: 409 K3_TRANSITION_BLOCKED (committed).',
    ],
    example: {
      request: { adjustments: [], loss_carryforward: { deficit: 100000, reason: 'Avtal ger vinst 2027.' }, manual_items: [] },
      response: { data: { journal_entry_id: 'c41d…', transition_date: '2026-01-01', opening_deferred_tax: 20600, lines: [] }, meta: META },
    },
  },
  input: K3TransitionPostingSchema,
  output: z.object({
    journal_entry_id: z.string().nullable(),
    transition_date: z.string(),
    opening_deferred_tax: z.number(),
    lines: z.array(VoucherLine),
  }),
  errorCodes: ['K3_TRANSITION_BLOCKED', 'INVALID_K3_TRANSITION'],
  http: { method: 'POST', path: `${V}/k3-transition/commit` },
  mcp: {
    name: 'gnubok_commit_k3_transition',
    title: 'Commit K3 Transition',
    description:
      'Stage the K3 transition voucher (35.11): opening deferred tax (unless 35.27) and stated balance sheet adjustments against balanserat resultat, dated the first day of the first K3 year.',
    keywords: ['övergång till k3', 'ingångsbalansräkning', 'uppskjuten skatt övergång', 'justering mot eget kapital', 'k3 35.11'],
    stage: { pendingType: 'commit_k3_transition', title: () => 'Bokför övergången till K3' },
  },
  run: async (ctx, input, { dryRun }) => {
    const lines = (preview: Awaited<ReturnType<typeof previewK3Transition>>) =>
      preview.lines.map((line) => ({
        account_number: line.account_number,
        debit: Number(line.debit_amount) || 0,
        credit: Number(line.credit_amount) || 0,
        description: line.line_description ?? null,
      }))
    if (dryRun) {
      const preview = await previewK3Transition(ctx.supabase, ctx.companyId, input)
      return {
        ok: true,
        dryRun: true,
        preview: {
          transition_date: preview.transition_date,
          equity_account: preview.equity_account,
          opening_deferred_tax: preview.deferred_tax.opening,
          deferred_tax_relief: preview.deferred_tax.relief,
          lines: lines(preview),
          warnings: preview.warnings,
        },
      }
    }
    const result = await commitK3TransitionPosting(ctx.supabase, ctx.companyId, ctx.userId, input)
    return {
      ok: true,
      data: {
        journal_entry_id: result.entry?.id ?? null,
        transition_date: result.preview.transition_date,
        opening_deferred_tax: result.preview.deferred_tax.opening,
        lines: lines(result.preview),
      },
    }
  },
})

export const K3_OPERATIONS = [
  assetsValueAdjustmentsCreate,
  assetsComponentsReplace,
  assetsTaxPlanSet,
  assetsTransitionSplitSet,
  fiscalPeriodsDeferredTaxSet,
  companyAccountingPoliciesUpdate,
  k3TransitionGet,
  k3TransitionStart,
  k3TransitionUpdate,
  k3TransitionDelete,
  k3TransitionCommit,
] as const
