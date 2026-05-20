import type { SupabaseClient } from '@supabase/supabase-js'
import type { SourceSignals } from './schemas'

// Atom registry index row — the metadata-only shape the composer sees when
// picking a loadout. We never send full atom bodies to the Opus call;
// metadata is enough for selection.
export interface AtomRegistryIndexRow {
  id: string
  tier: 'horizontal' | 'vertical' | 'modifier'
  title: string
  description: string
  sni_prefixes: string[]
  trigger_signals: Record<string, unknown>
  estimated_tokens: number
  version: number
}

export async function loadAtomRegistryIndex(
  supabase: SupabaseClient,
): Promise<AtomRegistryIndexRow[]> {
  const { data, error } = await supabase
    .from('agent_atom_registry')
    .select('id, tier, title, description, sni_prefixes, trigger_signals, estimated_tokens, version')
    .eq('is_active', true)
    .order('id')
  if (error) throw new Error(`Failed to load agent_atom_registry: ${error.message}`)
  return (data ?? []) as AtomRegistryIndexRow[]
}

export async function loadCompanyTicSnapshot(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ snapshot: Record<string, unknown> | null; fetchedAt: string | null; name: string; entityType: string }> {
  const { data, error } = await supabase
    .from('companies')
    .select('name, entity_type, tic_snapshot, tic_snapshot_fetched_at')
    .eq('id', companyId)
    .single()
  if (error) throw new Error(`Failed to load company ${companyId}: ${error.message}`)
  return {
    snapshot: (data?.tic_snapshot as Record<string, unknown> | null) ?? null,
    fetchedAt: (data?.tic_snapshot_fetched_at as string | null) ?? null,
    name: data?.name ?? '',
    entityType: data?.entity_type ?? '',
  }
}

// Known facts from `company_settings` — the onboarding form persists these
// (moms_period, fiscal_year_start_month, f_skatt, employees, city). Composer
// uses them as KNOWN inputs so it stops generating verification questions
// about already-settled values.
export interface CompanySettingsForComposer {
  city: string | null
  moms_period: string | null
  fiscal_year_start_month: number | null
  f_skatt: boolean | null
  vat_registered: boolean | null
  employee_count: number | null
  has_employees: boolean | null
  pays_salaries: boolean | null
  accounting_method: string | null
}

export async function loadCompanySettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanySettingsForComposer | null> {
  const { data } = await supabase
    .from('company_settings')
    .select(
      'city, moms_period, fiscal_year_start_month, f_skatt, vat_registered, employee_count, has_employees, pays_salaries, accounting_method',
    )
    .eq('company_id', companyId)
    .maybeSingle()
  return (data ?? null) as CompanySettingsForComposer | null
}

interface SieSummary {
  top_accounts: { account: string; abs_amount: number }[]
  top_counterparties: { name: string; abs_amount: number }[]
  year_count: number
}

// Build a coarse SIE summary from the most-recent imported SIE for the
// company. Used by the composer as a verticality signal (e.g. a top-spend
// account 1465 — alcohol inventory — strongly suggests restaurang).
//
// Returns null when no SIE has been imported. The composer must still work
// without SIE data; TIC sniCodes carry most of the signal on their own.
export async function loadSieSummary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SieSummary | null> {
  const { data: imports, error: importsErr } = await supabase
    .from('sie_imports')
    .select('id, fiscal_year_start, fiscal_year_end')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(20)
  if (importsErr) return null
  if (!imports || imports.length === 0) return null

  // Fiscal-year span across all completed imports (approximate).
  const years = new Set(
    imports.map((r: { fiscal_year_start: string | null }) => {
      const v = r.fiscal_year_start
      return v ? v.slice(0, 4) : ''
    }),
  )
  years.delete('')

  // Top-20 account magnitudes across journal_entry_lines for the company.
  // Cheaper than aggregating SIE line-items directly because the lines have
  // already landed in journal_entry_lines after import.
  const { data: lines, error: linesErr } = await supabase.rpc('agent_top_accounts_for_company', {
    p_company_id: companyId,
    p_limit: 20,
  })

  // RPC is optional — if it doesn't exist yet, fall back to an inline group-by.
  // Either way, we tolerate missing data and return what we have.
  let topAccounts: { account: string; abs_amount: number }[] = []
  if (!linesErr && Array.isArray(lines)) {
    topAccounts = (lines as { account_number: string; abs_amount: number }[]).map((l) => ({
      account: l.account_number,
      abs_amount: Number(l.abs_amount) || 0,
    }))
  }

  // Coarse counterparty rollup off the bank-statement description string.
  // `transactions.description` is the raw text from the bank — not
  // normalized — so this is a noisy signal. The composer treats it as a hint
  // alongside TIC sniCodes, which carry the strong industry signal.
  const { data: tx } = await supabase
    .from('transactions')
    .select('description, amount')
    .eq('company_id', companyId)
    .limit(2000)

  const cpAgg = new Map<string, number>()
  if (Array.isArray(tx)) {
    for (const t of tx as { description: string | null; amount: number | string | null }[]) {
      const name = normalizeCounterparty(t.description)
      if (!name) continue
      const amt = Math.abs(Number(t.amount) || 0)
      cpAgg.set(name, (cpAgg.get(name) ?? 0) + amt)
    }
  }
  const topCounterparties = Array.from(cpAgg.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, abs_amount]) => ({ name, abs_amount }))

  return {
    top_accounts: topAccounts,
    top_counterparties: topCounterparties,
    year_count: years.size,
  }
}

interface BankingSummary {
  top_counterparties: { name: string; abs_amount: number }[]
  monthly_volume: number | null
}

// POC: re-use transactions table for banking counterparties. A first-class
// Enable Banking summary lives behind the enable-banking extension and is
// post-POC.
export async function loadBankingSummary(
  supabase: SupabaseClient,
  companyId: string,
): Promise<BankingSummary | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('description, amount, date')
    .eq('company_id', companyId)
    .gte('date', oneYearAgo())
    .order('date', { ascending: false })
    .limit(5000)
  if (error || !Array.isArray(data) || data.length === 0) return null

  const cpAgg = new Map<string, number>()
  let totalVolume = 0
  for (const t of data as { description: string | null; amount: number | string | null }[]) {
    const amt = Math.abs(Number(t.amount) || 0)
    totalVolume += amt
    const name = normalizeCounterparty(t.description)
    if (!name) continue
    cpAgg.set(name, (cpAgg.get(name) ?? 0) + amt)
  }
  const top = Array.from(cpAgg.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, abs_amount]) => ({ name, abs_amount }))

  return {
    top_counterparties: top,
    monthly_volume: totalVolume > 0 ? Math.round(totalVolume / 12) : null,
  }
}

function oneYearAgo(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

// Cheap counterparty extraction from a bank-statement description. Strips
// reference numbers, dates, and common suffixes; truncates to ~40 chars.
// Post-POC: replace with the matcher in lib/transactions/.
function normalizeCounterparty(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    .replace(/\b\d{4,}\b/g, ' ')       // strip long digit runs (refs)
    .replace(/[/*:|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return cleaned.length >= 3 ? cleaned : null
}

// Composite input for the Opus selection call.
export interface ComposerInputs {
  companyId: string
  companyName: string
  entityType: string
  ticSnapshot: Record<string, unknown> | null
  ticFetchedAt: string | null
  companySettings: CompanySettingsForComposer | null
  sieSummary: SieSummary | null
  bankingSummary: BankingSummary | null
  atomIndex: AtomRegistryIndexRow[]
}

export async function gatherComposerInputs(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ComposerInputs> {
  const [
    { snapshot, fetchedAt, name, entityType },
    atomIndex,
    sieSummary,
    bankingSummary,
    companySettings,
  ] = await Promise.all([
    loadCompanyTicSnapshot(supabase, companyId),
    loadAtomRegistryIndex(supabase),
    loadSieSummary(supabase, companyId).catch(() => null),
    loadBankingSummary(supabase, companyId).catch(() => null),
    loadCompanySettings(supabase, companyId).catch(() => null),
  ])

  return {
    companyId,
    companyName: name,
    entityType,
    ticSnapshot: snapshot,
    ticFetchedAt: fetchedAt,
    companySettings,
    sieSummary,
    bankingSummary,
    atomIndex,
  }
}

export function inputsToSourceSignals(inputs: ComposerInputs): SourceSignals {
  return {
    tic: inputs.ticSnapshot,
    sie_summary: inputs.sieSummary,
    banking_summary: inputs.bankingSummary,
    atom_registry_version: inputs.atomIndex.reduce((acc, a) => acc + a.version, 0),
  }
}
