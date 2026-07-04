import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureTicSnapshot } from '@/lib/agent/composer/tic-fetch'
import AgentOnboarding from '@/components/onboarding/agent/AgentOnboarding'

export const dynamic = 'force-dynamic'

// /onboarding/agent: Phase A (real-timed build) and Phase B (review) of the
// specialized accountant agent build sequence.
//
// Plan refs: dev_docs/specialized-agent-plan.md §7 (Build-sequence UX),
// §15 Phase 2 (Build-sequence UX).
export default async function AgentOnboardingPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  // Sandbox companies ship with a pre-built verified agent_profile: the
  // build flow on this page would call TIC and the gated composer stream,
  // both of which 403. Send them back to the dashboard where the demo
  // assistant is already visible via the sheet preview.
  const { data: settingsForSandbox } = await supabase
    .from('company_settings')
    .select('is_sandbox')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsForSandbox?.is_sandbox) redirect('/')

  // Trigger the TIC live-fetch + cache before the field-resolving query
  // below. ensureTicSnapshot is fast on cache-hit (single SELECT) and
  // best-effort on miss: it never throws. Phase A still runs through the
  // streaming endpoint; this just lets the initial Phase B render show the
  // SNI/verksamhetsbeskrivning when the user returns to the page after
  // stream completion.
  const hdrs = await headers()
  const cookieHeader = hdrs.get('cookie') ?? ''
  const host = hdrs.get('host') ?? 'localhost:3000'
  const proto = hdrs.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  const origin = `${proto}://${host}`
  // upgradeV1: this is the one place the v2-only sections (statuses,
  // beneficialOwners, payrolls, …) materially drive the composer, and it's
  // a deliberate once-per-company action: safe to spend the TIC calls to
  // bring a pre-v2 snapshot up to date.
  await ensureTicSnapshot({ supabase, companyId, cookieHeader, origin, upgradeV1: true })

  // Fetch the small handful of fields we render directly into Phase B so the
  // user sees real values (not "Laddar…") the moment the stream finishes.
  // company_settings is a separate fetch because it carries the onboarding-
  // form data (moms_period, fiscal_year_start_month, f_skatt, city, …) that
  // never makes it onto `companies` proper.
  const [{ data: company }, { data: profile }, { data: existingProfile }, { data: settings }] =
    await Promise.all([
      supabase
        .from('companies')
        .select('name, entity_type, org_number, tic_snapshot')
        .eq('id', companyId)
        .single(),
      supabase.from('profiles').select('full_name').eq('id', user.id).single(),
      supabase
        .from('agent_profiles')
        .select('company_id, profile_summary, verified_at')
        .eq('company_id', companyId)
        .maybeSingle(),
      supabase
        .from('company_settings')
        .select(
          'city, address_line1, postal_code, f_skatt, vat_registered, moms_period, fiscal_year_start_month, employee_count, has_employees',
        )
        .eq('company_id', companyId)
        .maybeSingle(),
    ])

  if (!company) redirect('/onboarding')

  const firstName = profile?.full_name?.split(' ')[0] ?? null
  // Pre-render-friendly snapshot of company info: used to seed Phase B fields
  // before the stream completes so the layout doesn't jump.
  const initialFields = buildInitialFields(company, settings)

  // Atom titles: slug-derived labels look ugly ("Konsult It",
  // "Single Shareholder Ab Fmb"). Fetch the registry titles once and pass them
  // to the review card so chips render as authored.
  const { data: atomRows } = await supabase
    .from('agent_atom_registry')
    .select('id, title')
    .eq('is_active', true)
    .is('parent_atom_id', null) // skill titles only; reference children never appear as profile chips
  const atomTitles: Record<string, string> = {}
  for (const row of (atomRows ?? []) as { id: string; title: string }[]) {
    atomTitles[row.id] = row.title
  }

  return (
    <AgentOnboarding
      companyId={companyId}
      companyName={company.name}
      firstName={firstName}
      initialFields={initialFields}
      atomTitles={atomTitles}
      alreadyVerified={Boolean(existingProfile?.verified_at)}
      existingSummary={existingProfile?.profile_summary ?? null}
    />
  )
}

interface InitialFields {
  entity_type_label: string
  // Multiple SNI codes: most companies have one but some are
  // multi-vertical (e.g. konsult + lagerförsäljning).
  sni_codes: { code: string; name: string }[]
  // Verksamhetsbeskrivning (purpose) from Bolagsverket via TIC.
  purpose: string | null
  city: string | null
  fiscal_period: string | null
  vat_period: string | null
  f_skatt: string | null
  employees: string | null
}

interface CompanySettingsForPhaseB {
  city: string | null
  address_line1: string | null
  postal_code: string | null
  f_skatt: boolean | null
  vat_registered: boolean | null
  moms_period: string | null
  fiscal_year_start_month: number | null
  employee_count: number | null
  has_employees: boolean | null
}

function buildInitialFields(
  company: {
    name: string
    entity_type: string
    org_number: string | null
    tic_snapshot: Record<string, unknown> | null
  },
  settings: CompanySettingsForPhaseB | null,
): InitialFields {
  const tic = (company.tic_snapshot ?? null) as Record<string, unknown> | null
  const entityLabel =
    company.entity_type === 'aktiebolag'
      ? 'AB'
      : company.entity_type === 'enskild_firma'
        ? 'Enskild firma'
        : company.entity_type

  // Tier the resolution: TIC snapshot (if cached) wins because it's the
  // authoritative Bolagsverket data; company_settings is the user-entered
  // fallback from onboarding. Either can be missing.
  let sniCodes: { code: string; name: string }[] = []
  let purpose: string | null = null
  let city: string | null = null
  let fSkatt: string | null = null
  let vatPeriod: string | null = null
  let fiscalPeriod: string | null = null
  let employees: string | null = null

  if (tic) {
    const sni = (tic.sniCodes as { code: string; name: string }[] | undefined) ?? []
    if (Array.isArray(sni)) sniCodes = sni
    const tp = tic.purpose
    if (typeof tp === 'string' && tp.trim().length > 0) purpose = tp.trim()
    const addr = tic.address as { city: string | null } | null
    if (addr?.city) city = addr.city
    const reg = tic.registration as { fTax?: boolean } | undefined
    if (reg) fSkatt = reg.fTax ? 'Aktivt' : 'Saknas'
    if (tic.employeeRange) employees = tic.employeeRange as string
    // v2 caches `fiscalYear` (current fiscal-year configuration) on the
    // snapshot. Prefer it over the user-entered value below so onboarding
    // can show the registered fiscal period from Bolagsverket without
    // making the user re-enter it.
    const ticFiscal = tic.fiscalYear as { startMonthDay?: string | null } | null
    const startMonth = parseTicStartMonth(ticFiscal?.startMonthDay)
    if (startMonth != null) fiscalPeriod = fiscalYearLabel(startMonth)
  }

  if (settings) {
    if (!city && settings.city) city = settings.city
    if (!fSkatt && settings.f_skatt != null) {
      fSkatt = settings.f_skatt ? 'Aktivt' : 'Saknas'
    }
    if (settings.moms_period) {
      vatPeriod = momsPeriodLabel(settings.moms_period)
    }
    // settings.fiscal_year_start_month is the user-confirmed value: only
    // overwrite the TIC-derived label if the user has explicitly set it
    // (i.e. when there was no TIC fiscalYear AND they entered it manually).
    if (!fiscalPeriod && settings.fiscal_year_start_month != null) {
      fiscalPeriod = fiscalYearLabel(settings.fiscal_year_start_month)
    }
    if (!employees && settings.employee_count != null) {
      employees = String(settings.employee_count)
    } else if (!employees && settings.has_employees != null) {
      employees = settings.has_employees ? 'Ja' : 'Nej'
    }
  }

  return {
    entity_type_label: entityLabel,
    sni_codes: sniCodes,
    purpose,
    city,
    fiscal_period: fiscalPeriod,
    vat_period: vatPeriod,
    f_skatt: fSkatt,
    employees,
  }
}

// Parse TIC v2's `startMonthDay` ("MM-DD") into a month number 1-12. Returns
// null when the field is missing or malformed so the caller falls back to
// company_settings.fiscal_year_start_month.
function parseTicStartMonth(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{1,2})-\d{1,2}$/.exec(value)
  if (!match) return null
  const month = Number(match[1])
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return month
}

function momsPeriodLabel(period: string): string {
  switch (period) {
    case 'monthly':
      return 'Månadsmoms'
    case 'quarterly':
      return 'Kvartalsmoms'
    case 'yearly':
      return 'Årsmoms'
    default:
      return period
  }
}

// "fiscal_year_start_month=1" → "januari-december".
function fiscalYearLabel(startMonth: number): string {
  const months = [
    'januari',
    'februari',
    'mars',
    'april',
    'maj',
    'juni',
    'juli',
    'augusti',
    'september',
    'oktober',
    'november',
    'december',
  ]
  if (startMonth < 1 || startMonth > 12) return ''
  const startIdx = startMonth - 1
  const endIdx = (startIdx + 11) % 12
  return `${months[startIdx]}-${months[endIdx]}`
}
