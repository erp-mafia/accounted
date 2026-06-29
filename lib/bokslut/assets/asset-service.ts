import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import type {
  Asset,
  AssetCategory,
  DepreciationMethod,
  K3Component,
  CreateJournalEntryLineInput,
  JournalEntry,
  VatTreatment,
} from '@/types'

/**
 * Default BAS account triples per category. The user can override at create
 * time; these only kick in when the form doesn't specify accounts. Every
 * account here MUST exist in BAS_REFERENCE (lib/bookkeeping/bas-data/) so the
 * engine's backfillStandardBASAccounts can seed it on a minimal chart —
 * otherwise depreciation throws AccountsNotInChartError (#755). A guard test in
 * asset-service.test.ts enforces that invariant.
 *
 * vehicle (1240) and computer (1250) both sit in the maskiner-och-inventarier
 * asset range, so their depreciation maps to 7832 (Avskrivningar på
 * inventarier, verktyg och installationer) — 7833/7834 are not in the standard
 * BAS catalog (removed as non-standard in #463).
 */
export const DEFAULT_ACCOUNTS_BY_CATEGORY: Record<
  AssetCategory,
  { asset: string; accumulated: string; expense: string }
> = {
  immaterial: { asset: '1010', accumulated: '1019', expense: '7810' },
  building: { asset: '1110', accumulated: '1119', expense: '7821' },
  land_improvement: { asset: '1150', accumulated: '1159', expense: '7824' },
  machinery: { asset: '1210', accumulated: '1219', expense: '7831' },
  equipment: { asset: '1220', accumulated: '1229', expense: '7832' },
  vehicle: { asset: '1240', accumulated: '1249', expense: '7832' },
  computer: { asset: '1250', accumulated: '1259', expense: '7832' },
  other_tangible: { asset: '1290', accumulated: '1299', expense: '7839' },
}

export interface CreateAssetInput {
  name: string
  category: AssetCategory
  acquisition_date: string
  acquisition_cost: number
  salvage_value?: number
  useful_life_months: number
  depreciation_method?: DepreciationMethod
  /** Required when depreciation_method = 'restvardesavskrivning_25'. */
  restvarde_target?: number | null
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
  /** K3 component depreciation (BFNAR 2012:1 ch.17.4). When non-null, the
   *  engine sums per-component linear depreciation instead of applying
   *  `depreciation_method` to the asset as a whole. The API layer rejects
   *  writes for K2 companies with K3_REQUIRED_FOR_COMPONENTS. */
  k3_components?: K3Component[] | null
  notes?: string
}

/**
 * Create a new asset. Defaults BAS accounts from the category mapping when
 * the caller doesn't override them. Does NOT post a journal entry — the
 * acquisition is assumed to already be in the books (bank payment or
 * supplier invoice). Posting an acquisition entry alongside an existing
 * payment would double-count.
 */
export async function createAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateAssetInput,
): Promise<Asset> {
  const defaults = DEFAULT_ACCOUNTS_BY_CATEGORY[input.category]
  const method: DepreciationMethod = input.depreciation_method ?? 'linear'
  // The DB CHECK constraint enforces the biconditional between method and
  // restvarde_target. Pass null explicitly when not restvärde so a stale
  // value never leaks through.
  const restvarde =
    method === 'restvardesavskrivning_25' ? input.restvarde_target ?? null : null
  const row = {
    user_id: userId,
    company_id: companyId,
    name: input.name,
    category: input.category,
    acquisition_date: input.acquisition_date,
    acquisition_cost: input.acquisition_cost,
    salvage_value: input.salvage_value ?? 0,
    useful_life_months: input.useful_life_months,
    depreciation_method: method,
    restvarde_target: restvarde,
    bas_asset_account: input.bas_asset_account ?? defaults.asset,
    bas_accumulated_account: input.bas_accumulated_account ?? defaults.accumulated,
    bas_expense_account: input.bas_expense_account ?? defaults.expense,
    // K3 components are persisted as JSONB. The route handler enforces the
    // accounting_framework='k3' gate; here we only pass the value through
    // (null when omitted, so K2 assets stay clean).
    k3_components: input.k3_components ?? null,
    notes: input.notes ?? null,
  }

  const { data, error } = await supabase
    .from('assets')
    .insert(row)
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create asset: ${error?.message ?? 'unknown'}`)
  }
  return data as Asset
}

export async function listAssets(
  supabase: SupabaseClient,
  companyId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Asset[]> {
  let query = supabase
    .from('assets')
    .select('*')
    .eq('company_id', companyId)
    .order('acquisition_date', { ascending: true })

  if (options.activeOnly) {
    query = query.is('disposed_at', null)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to list assets: ${error.message}`)
  return (data ?? []) as Asset[]
}

export async function getAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<Asset | null> {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('id', assetId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load asset: ${error.message}`)
  return (data as Asset | null) ?? null
}

/**
 * Thrown when the caller tries to correct an asset's acquisition basis
 * (date / cost / category) after that basis has already driven postings —
 * i.e. the asset is disposed, or planenliga avskrivningar have been booked.
 * Allowing the edit would silently desync the posted vouchers from the
 * register, so the caller must reverse/storno first. The `code` field is
 * read by errorResponse() (see lib/errors/structured-errors.ts) to map this
 * to a 409.
 */
export class AssetCorrectionBlockedError extends Error {
  readonly code = 'ASSET_CORRECTION_BLOCKED'
  constructor(readonly reason: 'disposed' | 'depreciation_posted') {
    super(
      reason === 'disposed'
        ? 'Cannot correct acquisition date/cost/category of a disposed asset — reverse the disposal first.'
        : 'Cannot correct acquisition date/cost/category after depreciation has been posted — reverse the depreciation (storno) first.',
    )
    this.name = 'AssetCorrectionBlockedError'
  }
}

export interface UpdateAssetInput {
  name?: string
  notes?: string | null
  /** "Correction" fields — they redefine the depreciation basis, so changing
   *  them implies the original entry was wrong. Only permitted while the asset
   *  is neither disposed nor depreciated (updateAsset() enforces; throws
   *  AssetCorrectionBlockedError otherwise). Use the disposal/storno flow for a
   *  real change to an already-depreciated asset. */
  category?: AssetCategory
  acquisition_date?: string
  acquisition_cost?: number
  /** Salvage value, useful life, method, accounts — editable as long as the
   *  asset isn't disposed yet (DB trigger enforces this beyond the API).
   *  Unlike the correction fields above, revising useful life or method is a
   *  legitimate *prospective* change and stays allowed after depreciation. */
  salvage_value?: number
  useful_life_months?: number
  depreciation_method?: DepreciationMethod
  /** Editable as long as method=restvärdeavskrivning. Set to null when
   *  switching back to a non-restvärde method (the DB CHECK enforces). */
  restvarde_target?: number | null
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
  /** K3 component breakdown. Pass null to clear an existing breakdown
   *  (engine then falls back to depreciation_method). The route handler
   *  enforces accounting_framework='k3' + sum validation before delegating. */
  k3_components?: K3Component[] | null
}

/**
 * True when at least one depreciation_schedules row for this asset is linked
 * to a posted journal entry. A `head` count keeps it cheap — we only need
 * existence, not the rows. Used to gate acquisition-basis corrections.
 */
async function hasPostedDepreciation(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('depreciation_schedules')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
    .not('journal_entry_id', 'is', null)
  if (error) {
    throw new Error(
      `Failed to check posted depreciation for asset ${assetId}: ${error.message}`,
    )
  }
  return (count ?? 0) > 0
}

/**
 * Catch depreciation that was posted by hand (a manual avskrivningsverifikat),
 * which leaves no depreciation_schedules row and so slips past
 * hasPostedDepreciation. We look at the ledger instead: any posted CREDIT to
 * the asset's ackumulerade-avskrivningar account (12x9) is depreciation.
 *
 * The wrinkle is shared accounts — siblings in the same category default to
 * the same 12x9, so a sibling's *engine* avskrivning would otherwise look like
 * depreciation of this asset. We exclude entries that depreciation_schedules
 * attributes to a *different* asset, so engine siblings don't cause a false
 * block. What remains is depreciation tied to this asset (engine or manual)
 * plus the rare case of a manual sibling entry on a shared account — there we
 * err toward blocking, which is the safe direction for a basis correction.
 */
async function hasManualDepreciationPosted(
  supabase: SupabaseClient,
  companyId: string,
  asset: Asset,
): Promise<boolean> {
  // Engine-posted depreciation entries that belong to OTHER assets — these are
  // safely attributable and must not block a correction of this asset.
  const { data: otherSched, error: schedError } = await supabase
    .from('depreciation_schedules')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .neq('asset_id', asset.id)
    .not('journal_entry_id', 'is', null)
  if (schedError) {
    throw new Error(
      `Failed to load sibling depreciation entries for asset ${asset.id}: ${schedError.message}`,
    )
  }
  const siblingEngineEntries = new Set(
    ((otherSched ?? []) as { journal_entry_id: string | null }[])
      .map((r) => r.journal_entry_id)
      .filter((id): id is string => id !== null),
  )

  const { data: lines, error } = await supabase
    .from('journal_entry_lines')
    .select('journal_entry_id, journal_entries!inner(company_id, status)')
    .eq('account_number', asset.bas_accumulated_account)
    .eq('journal_entries.company_id', companyId)
    .eq('journal_entries.status', 'posted')
    .gt('credit_amount', 0)
  if (error) {
    throw new Error(
      `Failed to scan ledger depreciation for asset ${asset.id}: ${error.message}`,
    )
  }
  return ((lines ?? []) as { journal_entry_id: string }[]).some(
    (line) => !siblingEngineEntries.has(line.journal_entry_id),
  )
}

export async function updateAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  inputParam: UpdateAssetInput,
): Promise<Asset> {
  // Copy so we can adjust restvarde_target without mutating the caller's object.
  let input: UpdateAssetInput = { ...inputParam }

  // Almost every meaningful patch needs the current row (range checks, the
  // method/target biconditional, the correction guard). Load it once.
  const needsExisting =
    input.category !== undefined ||
    input.acquisition_date !== undefined ||
    input.acquisition_cost !== undefined ||
    input.depreciation_method !== undefined ||
    input.restvarde_target !== undefined ||
    input.bas_asset_account !== undefined ||
    input.bas_accumulated_account !== undefined ||
    input.bas_expense_account !== undefined
  let existing: Asset | null = null
  if (needsExisting) {
    existing = await getAsset(supabase, companyId, assetId)
    if (!existing) throw new Error('Asset not found')
  }

  // ── Correction guard ──────────────────────────────────────────────
  // acquisition_date / acquisition_cost / category redefine the depreciation
  // basis. Correcting a fresh data-entry mistake is safe, but once the basis
  // has driven postings (disposal voucher or booked avskrivningar) the edit
  // would silently desync those vouchers from the register. Force those cases
  // through reverse/storno instead.
  const isCorrection =
    input.category !== undefined ||
    input.acquisition_date !== undefined ||
    input.acquisition_cost !== undefined
  if (isCorrection && existing) {
    if (existing.disposed_at) {
      throw new AssetCorrectionBlockedError('disposed')
    }
    // Engine-driven (depreciation_schedules) OR hand-posted (ledger) — either
    // means the basis has driven postings and a correction must go via storno.
    if (
      (await hasPostedDepreciation(supabase, companyId, assetId)) ||
      (await hasManualDepreciationPosted(supabase, companyId, existing))
    ) {
      throw new AssetCorrectionBlockedError('depreciation_posted')
    }
  }

  // ── Category change → realign BAS accounts ────────────────────────
  // The BAS triple is category-scoped (INK2R mapping + engine defaults depend
  // on it). When the category changes and the caller didn't supply explicit
  // accounts, reset the triple to the new category's defaults so the chart
  // stays aligned — mirrors createAsset()'s defaulting.
  if (
    input.category !== undefined &&
    existing &&
    input.category !== existing.category &&
    input.bas_asset_account === undefined &&
    input.bas_accumulated_account === undefined &&
    input.bas_expense_account === undefined
  ) {
    const defaults = DEFAULT_ACCOUNTS_BY_CATEGORY[input.category]
    input = {
      ...input,
      bas_asset_account: defaults.asset,
      bas_accumulated_account: defaults.accumulated,
      bas_expense_account: defaults.expense,
    }
  }

  // ── BAS account range validation ──────────────────────────────────
  // Defense-in-depth: refuse anything outside the legitimate range for the
  // asset's (possibly newly-changed) category. Validates against the final
  // category so a category+account change is checked as a unit.
  if (
    input.bas_asset_account ||
    input.bas_accumulated_account ||
    input.bas_expense_account
  ) {
    if (!existing) throw new Error('Asset not found')
    const finalCategory = input.category ?? existing.category
    const ranges = BAS_RANGES_BY_CATEGORY[finalCategory]
    if (input.bas_asset_account && !inBasRange(input.bas_asset_account, ranges.asset)) {
      throw new Error(
        `bas_asset_account ${input.bas_asset_account} is outside ${ranges.asset[0]}–${ranges.asset[1]} for ${finalCategory}`,
      )
    }
    if (
      input.bas_accumulated_account &&
      !inBasRange(input.bas_accumulated_account, ranges.accumulated)
    ) {
      throw new Error(
        `bas_accumulated_account ${input.bas_accumulated_account} is outside ${ranges.accumulated[0]}–${ranges.accumulated[1]} for ${finalCategory}`,
      )
    }
    if (
      input.bas_expense_account &&
      !inBasRange(input.bas_expense_account, ranges.expense)
    ) {
      throw new Error(
        `bas_expense_account ${input.bas_expense_account} is outside ${ranges.expense[0]}–${ranges.expense[1]} for ${finalCategory}`,
      )
    }
    // Anskaffning and ackumulerade-avskrivningar must be different accounts —
    // see CreateAssetSchema validateBasOverrides for the rationale.
    const finalAsset = input.bas_asset_account ?? existing.bas_asset_account
    const finalAccumulated = input.bas_accumulated_account ?? existing.bas_accumulated_account
    if (finalAsset === finalAccumulated) {
      throw new Error(
        'bas_asset_account and bas_accumulated_account must be different accounts',
      )
    }
  }

  // ── Method / restvärde-target biconditional ───────────────────────
  // Required iff restvärdeavskrivning. Resolve final method+target+cost across
  // the merged row (existing + patch) so we can null the target when switching
  // away, require it when switching in, and re-check the floor when the cost
  // itself is being corrected.
  if (
    input.depreciation_method !== undefined ||
    input.restvarde_target !== undefined ||
    input.acquisition_cost !== undefined
  ) {
    if (!existing) throw new Error('Asset not found')
    const finalMethod = input.depreciation_method ?? existing.depreciation_method
    const finalTarget =
      input.restvarde_target !== undefined ? input.restvarde_target : existing.restvarde_target
    const finalCost =
      input.acquisition_cost !== undefined ? input.acquisition_cost : Number(existing.acquisition_cost)
    if (finalMethod === 'restvardesavskrivning_25' && (finalTarget === null || finalTarget === undefined)) {
      throw new Error(
        'restvarde_target krävs när avskrivningsmetoden är restvärdeavskrivning (25 %).',
      )
    }
    if (finalMethod !== 'restvardesavskrivning_25' && finalTarget !== null && finalTarget !== undefined) {
      // Auto-null the target when switching away from restvärde so the DB
      // CHECK doesn't reject the update.
      input = { ...input, restvarde_target: null }
    }
    if (
      finalMethod === 'restvardesavskrivning_25' &&
      finalTarget !== null &&
      finalTarget !== undefined &&
      Number(finalTarget) >= Number(finalCost)
    ) {
      throw new Error(
        'restvarde_target måste vara lägre än anskaffningsvärdet — annars finns inget kvar att skriva av.',
      )
    }
  }

  const { data, error } = await supabase
    .from('assets')
    .update(input)
    .eq('id', assetId)
    .eq('company_id', companyId)
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to update asset: ${error?.message ?? 'unknown'}`)
  }
  return data as Asset
}

const BAS_RANGES_BY_CATEGORY: Record<
  AssetCategory,
  { asset: [string, string]; accumulated: [string, string]; expense: [string, string] }
> = {
  immaterial:      { asset: ['1010', '1099'], accumulated: ['1010', '1099'], expense: ['7810', '7819'] },
  building:        { asset: ['1100', '1199'], accumulated: ['1100', '1199'], expense: ['7820', '7829'] },
  land_improvement:{ asset: ['1150', '1159'], accumulated: ['1150', '1159'], expense: ['7820', '7829'] },
  machinery:       { asset: ['1210', '1219'], accumulated: ['1210', '1219'], expense: ['7830', '7839'] },
  equipment:       { asset: ['1220', '1229'], accumulated: ['1220', '1229'], expense: ['7830', '7839'] },
  vehicle:         { asset: ['1240', '1249'], accumulated: ['1240', '1249'], expense: ['7830', '7839'] },
  computer:        { asset: ['1250', '1259'], accumulated: ['1250', '1259'], expense: ['7830', '7839'] },
  other_tangible:  { asset: ['1280', '1299'], accumulated: ['1280', '1299'], expense: ['7830', '7839'] },
}

function inBasRange(account: string, range: [string, string]): boolean {
  return account >= range[0] && account <= range[1]
}

export interface DisposeAssetInput {
  /** ISO date of disposal — typically the day of sale or scrapping. */
  disposed_at: string
  /** Cash / receivable received for the asset, INCLUDING VAT when applicable.
   *  Zero for scrapping. */
  disposed_proceeds: number
  /** Optional override for the bank/receivable account credited with the
   *  proceeds. Defaults to 1930 (företagskonto). */
  proceeds_account?: string
  /** Fiscal period the disposal entry lands in. Caller resolves this from
   *  disposed_at — we don't auto-derive to keep the period-lock check at
   *  the route layer. */
  fiscal_period_id: string
  /**
   * Output VAT on the proceeds (ML 3 kap 3 § / 7 kap 3 §). When > 0, a
   * credit on the matching 26xx account is appended to the journal entry,
   * and `disposed_proceeds` is treated as the GROSS amount (incl. VAT).
   * The net (proceeds − vat) is what gets compared to NBV to compute
   * gain/loss. Defaults to 0 (sale was momsfri / outside scope).
   */
  proceeds_vat?: number
  /**
   * Treatment for `proceeds_vat`. Required when `proceeds_vat > 0` because
   * the engine needs to know which 26xx account to credit:
   *   - standard_25 → 2611
   *   - reduced_12  → 2621
   *   - reduced_6   → 2631
   *   - reverse_charge / export / exempt → no VAT line (treated as
   *     informational; proceeds_vat must be 0 in those cases)
   */
  vat_treatment?: VatTreatment
  /**
   * Jämkning amount per ML 8a kap 7 § — when the disposal happens inside
   * the korrigeringstid, the originally-deducted input VAT must be
   * partially paid back. The caller computes this via
   * computeJamkningAmount() (lib/bokslut/assets/jamkning.ts) and passes
   * the result here. A positive value means "pay back to the state" and
   * is booked as a CREDIT to 2641 (reverses the original input-VAT
   * deduction) with an offsetting debit on the asset's gain/loss account.
   * Zero / undefined = no jämkning line.
   */
  jamkning_amount?: number
  /** Audit metadata: remaining months in korrigeringstid at disposal date. */
  jamkning_remaining_months?: number
  /** Audit metadata: total korrigeringstid (60 or 120 months). */
  jamkning_total_months?: number
  /** Audit metadata: original input VAT deducted at acquisition. */
  jamkning_original_input_vat?: number
}

export interface DisposalResult {
  asset: Asset
  /** Disposal entry. Null when no entry was needed (zero-value, fully-
   *  depreciated asset scrapped for nothing). */
  disposal_entry: JournalEntry | null
  gain_or_loss: number
}

/**
 * Dispose of an asset. Posts a journal entry that:
 *   - Debit accumulated depreciation (to zero out the asset's accumulated
 *     account)
 *   - Credit acquisition cost (to zero out the asset's anskaffning account)
 *   - Debit proceeds account (bank / receivable) for sale price (gross,
 *     incl VAT)
 *   - Credit 26xx (output VAT) when the sale is momspliktig (standard_25 →
 *     2611, reduced_12 → 2621, reduced_6 → 2631)
 *   - Credit 2641 + Debit loss account for the jämkning amount when the
 *     disposal happens inside the korrigeringstid (ML 8a kap 4-7 §§)
 *   - Debit 78xx (loss on sale) OR Credit 30xx (gain on sale) for the
 *     net gain / loss vs NBV — accounts branch on category (3013/7813
 *     for immaterial, 3971/7971 for building / markanläggning, 3973/7973
 *     for everything else).
 *
 * Gain/loss is computed on the NET proceeds (excl VAT), since VAT is a
 * pass-through to Skatteverket and does not affect resultaträkningen.
 *
 * After posting, marks the asset row with disposed_at, disposed_proceeds,
 * disposed_proceeds_vat, disposed_vat_treatment, and jämkning audit fields.
 * The DB trigger then prevents further edits to financial fields.
 */
export async function disposeAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  input: DisposeAssetInput,
): Promise<DisposalResult> {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new Error('Asset not found')
  if (asset.disposed_at) {
    throw new Error('Asset is already disposed')
  }

  // Derive accumulated depreciation server-side from posted
  // depreciation_schedules so a malicious or buggy caller cannot inflate the
  // book-value calculation. Limitation: manual avskrivningsverifikationer
  // posted outside the engine aren't captured here. Phase 5+ can replace
  // this with a trial-balance scan on bas_accumulated_account.
  const accumulated = await sumPostedDepreciation(supabase, companyId, assetId)

  const acquisitionCost = Number(asset.acquisition_cost)
  const proceedsGross = round2(Number(input.disposed_proceeds))
  const proceedsVat = round2(Number(input.proceeds_vat ?? 0))
  const proceedsNet = round2(proceedsGross - proceedsVat)
  const vatTreatment = input.vat_treatment
  // Internal validation guard: when caller passes a VAT amount, treatment
  // must accompany it so we can resolve the BAS 26xx account. The API
  // layer also enforces this via Zod refinement; mirroring here keeps
  // the engine self-defending against direct callers (MCP, scripts).
  if (proceedsVat > 0.005 && !vatTreatment) {
    throw new Error(
      'vat_treatment krävs när proceeds_vat > 0 — engine kan inte avgöra rätt 26xx-konto.',
    )
  }
  // Treatments that produce no VAT line must carry 0 VAT.
  if (
    proceedsVat > 0.005 &&
    vatTreatment &&
    (vatTreatment === 'reverse_charge' ||
      vatTreatment === 'export' ||
      vatTreatment === 'exempt')
  ) {
    throw new Error(
      `proceeds_vat måste vara 0 för momsbehandling "${vatTreatment}".`,
    )
  }

  // Gain/loss is computed on the NET proceeds — VAT is pass-through and
  // never hits the income statement.
  const netBookValue = round2(acquisitionCost - accumulated)
  const gainOrLoss = round2(proceedsNet - netBookValue)
  const proceedsAccount = input.proceeds_account ?? '1930'

  // ── Jämkning (ML 8a kap 7 §) ──────────────────────────────────────
  // When the disposal happens inside the korrigeringstid, part of the
  // originally-deducted input VAT must be paid back. Caller passes the
  // precomputed amount (positive = debt to the state).
  //
  // Booking direction: We credit 2641 to reverse the original input-VAT
  // deduction (2641 normal balance is debit; a credit reduces the
  // deduction). The offset is debited to BAS 6991 — jämkning is a VAT
  // correction per ML 8a kap, NOT a disposal loss, so it must NOT hit
  // the 78xx förlust-vid-avyttring accounts. See the jämkning lines
  // below for details.
  const jamkning = round2(Number(input.jamkning_amount ?? 0))

  const lines: CreateJournalEntryLineInput[] = []

  if (accumulated > 0.005) {
    lines.push({
      account_number: asset.bas_accumulated_account,
      debit_amount: round2(accumulated),
      credit_amount: 0,
      line_description: `Avyttring: nollställ ack. avskrivning ${asset.name}`,
    })
  }
  lines.push({
    account_number: asset.bas_asset_account,
    debit_amount: 0,
    credit_amount: round2(acquisitionCost),
    line_description: `Avyttring: nollställ anskaffning ${asset.name}`,
  })
  if (proceedsGross > 0.005) {
    lines.push({
      account_number: proceedsAccount,
      debit_amount: proceedsGross,
      credit_amount: 0,
      line_description: `Avyttring: erhållet belopp ${asset.name}`,
    })
  }

  // Output VAT line — credit the matching 26xx account.
  if (proceedsVat > 0.005 && vatTreatment) {
    const vatAccount = outputVatAccountFor(vatTreatment)
    if (vatAccount) {
      lines.push({
        account_number: vatAccount,
        debit_amount: 0,
        credit_amount: proceedsVat,
        line_description: `Utgående moms ${vatRateLabel(vatTreatment)} avyttring ${asset.name}`,
      })
    }
  }

  // Disposal gain/loss accounts vary by asset class — BAS 2026 splits them
  // because INK2R routes each pair to a different field. Mixing them
  // misclassifies in the tax declaration.
  //   - immaterial            → 3013 (vinst) / 7813 (förlust)
  //   - building / markanlägg → 3971 / 7971
  //   - other tangible        → 3973 / 7973
  const isBuilding = asset.category === 'building' || asset.category === 'land_improvement'
  const gainAccount =
    asset.category === 'immaterial' ? '3013' : isBuilding ? '3971' : '3973'
  const lossAccount =
    asset.category === 'immaterial' ? '7813' : isBuilding ? '7971' : '7973'

  if (gainOrLoss > 0.005) {
    lines.push({
      account_number: gainAccount,
      debit_amount: 0,
      credit_amount: gainOrLoss,
      line_description: `Vinst vid avyttring av ${asset.name}`,
    })
  } else if (gainOrLoss < -0.005) {
    lines.push({
      account_number: lossAccount,
      debit_amount: Math.abs(gainOrLoss),
      credit_amount: 0,
      line_description: `Förlust vid avyttring av ${asset.name}`,
    })
  }

  // Jämkning lines — credit 2641 + debit 6991. Jämkning is a VAT
  // correction per ML 8a kap, NOT a disposal loss. Routing it through
  // the 78xx förlust-vid-avyttring accounts would distort both the
  // gain/loss line on the income statement and the INK2R mapping, and
  // mix tax-correction costs with disposal losses in the audit trail.
  // BAS 6991 "Övriga externa kostnader, avdragsgilla" is the seeded
  // catch-all för-en-extern-kostnad account that fits a repayment of
  // previously-deducted input VAT.
  if (jamkning > 0.005) {
    lines.push({
      account_number: '6991',
      debit_amount: jamkning,
      credit_amount: 0,
      line_description: `Jämkning av tidigare avdragen ingående moms enligt ML 8a kap (${asset.name})`,
    })
    lines.push({
      account_number: '2641',
      debit_amount: 0,
      credit_amount: jamkning,
      line_description: `Återförd ingående moms jämkning ${asset.name}`,
    })
  }

  // K3 component breakdown — when the asset was depreciated per-component,
  // we surface the component list in the journal entry notes so auditors
  // can trace which underlying components contributed to the disposal.
  // Gain/loss math is unchanged: total book value is still
  // acquisition_cost − accumulated_depreciation regardless of structure,
  // because component depreciations sum into the same accumulated account.
  const hasComponents =
    Array.isArray(asset.k3_components) && asset.k3_components.length > 0
  const componentNotes = hasComponents
    ? `K3-komponenter: ${(asset.k3_components ?? [])
        .map((c) => `${c.name} (${round2(Number(c.cost))} kr / ${c.useful_life_months} mån)`)
        .join('; ')}`
    : null

  let disposalEntry: JournalEntry | null = null
  if (lines.length > 0) {
    disposalEntry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.disposed_at,
      description: `Avyttring av tillgång: ${asset.name}`,
      source_type: 'manual',
      lines,
      ...(componentNotes ? { notes: componentNotes } : {}),
    })
  }

  const { data: updated, error: updateError } = await supabase
    .from('assets')
    .update({
      disposed_at: input.disposed_at,
      disposed_proceeds: proceedsGross,
      disposed_proceeds_vat: proceedsVat,
      disposed_vat_treatment: vatTreatment ?? null,
      jamkning_amount: jamkning,
      jamkning_remaining_months: input.jamkning_remaining_months ?? null,
      jamkning_total_months: input.jamkning_total_months ?? null,
      jamkning_original_input_vat: input.jamkning_original_input_vat ?? null,
    })
    .eq('id', assetId)
    .eq('company_id', companyId)
    .select('*')
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to mark asset disposed: ${updateError?.message ?? 'unknown'}`)
  }

  return {
    asset: updated as Asset,
    disposal_entry: disposalEntry,
    gain_or_loss: gainOrLoss,
  }
}

/** Resolve the BAS 26xx output-VAT account for a given VAT treatment.
 *  Returns null for treatments that produce no VAT line. */
function outputVatAccountFor(treatment: VatTreatment): string | null {
  switch (treatment) {
    case 'standard_25':
      return '2611'
    case 'reduced_12':
      return '2621'
    case 'reduced_6':
      return '2631'
    case 'reverse_charge':
    case 'export':
    case 'exempt':
      return null
  }
}

function vatRateLabel(treatment: VatTreatment): string {
  switch (treatment) {
    case 'standard_25':
      return '25%'
    case 'reduced_12':
      return '12%'
    case 'reduced_6':
      return '6%'
    default:
      return ''
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Sum every posted depreciation_schedules row for an asset to get accumulated
 * depreciation as of "now". Used by disposeAsset so the caller cannot
 * influence the book-value calculation.
 */
async function sumPostedDepreciation(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('depreciation_schedules')
    .select('planned_depreciation')
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
    .not('journal_entry_id', 'is', null)

  if (error) {
    throw new Error(`Failed to sum depreciation for asset ${assetId}: ${error.message}`)
  }

  type Row = { planned_depreciation: number | string }
  return ((data ?? []) as Row[]).reduce(
    (sum, row) => sum + (Number(row.planned_depreciation) || 0),
    0,
  )
}

/**
 * Sum prior depreciation booked against an asset's 78xx avskrivningskonto
 * up to and including `asOfDate`. Reads from journal_entry_lines so manually-
 * posted avskrivningsverifikationer (i.e. not driven by depreciation_schedules)
 * are also counted — the declining-balance engine needs the most accurate
 * net book value to compute the next period's charge.
 *
 * Only counts posted entries against the asset's `bas_expense_account`
 * (the 78xx avskrivningskonto), and only debits (since avskrivning = debit
 * 78xx / credit 12x9). Returns 0 if the asset has never been depreciated.
 *
 * Why we look at the expense account rather than the accumulated account:
 * the expense account is asset-specific by convention (7831 for machinery,
 * 7832 for equipment, etc.) so we can scope per-asset accurately, whereas
 * the accumulated account (12x9) may aggregate across assets in the same
 * category. Limitation: when multiple assets share the same bas_expense_account
 * we cannot disambiguate at the journal line level. The depreciation_schedules
 * sum (see `sumPostedDepreciation`) is the safer fallback in that case.
 * Callers that need exact per-asset accuracy should prefer the schedules sum.
 */
export async function getAccumulatedDepreciationAsOf(
  supabase: SupabaseClient,
  assetId: string,
  asOfDate: string,
): Promise<number> {
  // 1. Resolve the asset and its expense account first so we can target the
  //    correct 78xx code.
  const { data: asset, error: assetError } = await supabase
    .from('assets')
    .select('bas_expense_account, company_id')
    .eq('id', assetId)
    .maybeSingle()

  if (assetError) {
    throw new Error(`Failed to load asset for accumulated depreciation: ${assetError.message}`)
  }
  if (!asset) return 0

  type Row = { debit_amount: number | string | null; credit_amount: number | string | null }
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select(
      'debit_amount, credit_amount, journal_entries!inner(company_id, status, entry_date)',
    )
    .eq('account_number', asset.bas_expense_account)
    .eq('journal_entries.company_id', asset.company_id)
    .eq('journal_entries.status', 'posted')
    .lte('journal_entries.entry_date', asOfDate)

  if (error) {
    throw new Error(
      `Failed to sum accumulated depreciation for asset ${assetId}: ${error.message}`,
    )
  }

  return ((data ?? []) as Row[]).reduce((sum, row) => {
    // Expense account — normal balance is debit. Net = debit − credit so
    // any storno (reversal) is netted out.
    return sum + ((Number(row.debit_amount) || 0) - (Number(row.credit_amount) || 0))
  }, 0)
}
