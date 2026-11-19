/**
 * Representative companies for the "no visible change" snapshots: the menu
 * (src/lib/navigation/__tests__/menu-snapshot.test.ts), MCP's tools/list and
 * briefing (src/extensions/general/mcp-server/__tests__/
 * capabilities-snapshot.test.ts) and the v1 capabilities response
 * (src/app/api/v1/companies/[companyId]/capabilities/__tests__/
 * published-snapshot.test.ts).
 *
 * Each company is described by its database rows only, so the snapshots run
 * the production read path end to end and the test code never has to change
 * when the code behind it does: a snapshot that moves is a visible change.
 */
import { PAID_CAPABILITIES } from '@/lib/entitlements/keys'

export interface RepresentativeCompany {
  name: string
  id: string
  companies: {
    entity_type: string
    jurisdiction: string
    ledger_currency: string
    team_id: string | null
    archived_at: string | null
  }
  company_settings: {
    entity_type: string
    pays_salaries: boolean | null
    dimensions_enabled: boolean
    sales_orders_enabled: boolean
    quotes_enabled: boolean
    mileage_enabled: boolean
    accounting_method: string
    company_name: string
  }
  /** capability_grants rows that apply (company_capability_grant_rows). */
  grants: Array<{ capability_key: string; expires_at: string | null; source: string; team_id: string | null }>
  /** company_capability_config rows with enabled = false. */
  disabledConfigKeys: string[]
  subscription: { status: string } | null
  navFlags: { has_webshop: boolean; has_mileage_trips: boolean }
  hasExpenseClaims: boolean
  hasPosConnection: boolean
}

const FAR_FUTURE = '2099-01-01T00:00:00Z'
const LONG_AGO = '2020-01-01T00:00:00Z'

const grant = (key: string, source: string, expiresAt: string | null) => ({
  capability_key: key,
  expires_at: expiresAt,
  source,
  team_id: null,
})

const ALL_PAID = PAID_CAPABILITIES.map((key) => grant(key, 'stripe', null))

const settings = (
  entityType: string,
  overrides: Partial<RepresentativeCompany['company_settings']> = {},
): RepresentativeCompany['company_settings'] => ({
  entity_type: entityType,
  pays_salaries: null,
  dimensions_enabled: false,
  sales_orders_enabled: false,
  quotes_enabled: true,
  mileage_enabled: false,
  accounting_method: 'accrual',
  company_name: 'Representative',
  ...overrides,
})

const company = (entityType: string, archivedAt: string | null = null): RepresentativeCompany['companies'] => ({
  entity_type: entityType,
  jurisdiction: 'SE',
  ledger_currency: 'SEK',
  team_id: null,
  archived_at: archivedAt,
})

export const REPRESENTATIVE_COMPANIES: readonly RepresentativeCompany[] = [
  {
    name: 'aktiebolag, every plan capability, a paying subscription',
    id: 'a1a1a1a1-0000-4000-8000-000000000001',
    companies: company('aktiebolag'),
    company_settings: settings('aktiebolag'),
    grants: ALL_PAID,
    disabledConfigKeys: [],
    subscription: { status: 'active' },
    navFlags: { has_webshop: false, has_mileage_trips: false },
    hasExpenseClaims: false,
    hasPosConnection: false,
  },
  {
    name: 'enskild firma without salaries, trial expired (no plan capability)',
    id: 'a1a1a1a1-0000-4000-8000-000000000002',
    companies: company('enskild_firma'),
    company_settings: settings('enskild_firma', { pays_salaries: false, mileage_enabled: true }),
    grants: PAID_CAPABILITIES.filter((key) => key !== 'collections').map((key) => grant(key, 'trial', LONG_AGO)),
    disabledConfigKeys: [],
    subscription: null,
    navFlags: { has_webshop: false, has_mileage_trips: false },
    hasExpenseClaims: true,
    hasPosConnection: false,
  },
  {
    name: 'aktiebolag missing ai and bank_sync, bank_sync also turned off, every opt-in surface on',
    id: 'a1a1a1a1-0000-4000-8000-000000000003',
    companies: company('aktiebolag'),
    company_settings: settings('aktiebolag', {
      dimensions_enabled: true,
      sales_orders_enabled: true,
      quotes_enabled: false,
      mileage_enabled: true,
    }),
    grants: [grant('skatteverket', 'manual', FAR_FUTURE), grant('email_send', 'manual', FAR_FUTURE)],
    disabledConfigKeys: ['bank_sync'],
    subscription: null,
    navFlags: { has_webshop: true, has_mileage_trips: true },
    hasExpenseClaims: true,
    hasPosConnection: true,
  },
  {
    name: 'enskild firma that pays salaries, every plan capability, ai turned off',
    id: 'a1a1a1a1-0000-4000-8000-000000000004',
    companies: company('enskild_firma'),
    company_settings: settings('enskild_firma', { pays_salaries: true }),
    grants: ALL_PAID,
    disabledConfigKeys: ['ai'],
    subscription: { status: 'active' },
    navFlags: { has_webshop: false, has_mileage_trips: false },
    hasExpenseClaims: false,
    hasPosConnection: false,
  },
  {
    name: 'archived ekonomisk förening, every plan capability',
    id: 'a1a1a1a1-0000-4000-8000-000000000005',
    companies: company('ekonomisk_forening', '2026-09-01T00:00:00Z'),
    company_settings: settings('ekonomisk_forening'),
    grants: ALL_PAID,
    disabledConfigKeys: [],
    subscription: { status: 'active' },
    navFlags: { has_webshop: false, has_mileage_trips: false },
    hasExpenseClaims: false,
    hasPosConnection: false,
  },
  {
    name: 'ideell förening on an active trial',
    id: 'a1a1a1a1-0000-4000-8000-000000000006',
    companies: company('ideell_forening'),
    company_settings: settings('ideell_forening'),
    grants: PAID_CAPABILITIES.filter((key) => key !== 'collections').map((key) => grant(key, 'trial', FAR_FUTURE)),
    disabledConfigKeys: [],
    subscription: null,
    navFlags: { has_webshop: false, has_mileage_trips: false },
    hasExpenseClaims: false,
    hasPosConnection: false,
  },
]

/**
 * The per-table answers (createTableMockSupabase keys) for one company: what
 * every reader of the menu, the tool list, the briefing and the v1 report
 * may ask about it. Tables nobody asks about stay unset.
 */
export function representativeCompanyTables(c: RepresentativeCompany): Record<string, { data: unknown; error?: null }> {
  return {
    companies: { data: { id: c.id, name: 'Representative', org_number: null, ...c.companies } },
    company_settings: { data: { company_id: c.id, ...c.company_settings } },
    company_capability_config: {
      data: c.disabledConfigKeys.map((key) => ({ company_id: c.id, capability_key: key, enabled: false })),
    },
    company_subscriptions: { data: c.subscription },
    'rpc:company_capability_grant_rows': { data: c.grants },
    'rpc:get_dashboard_nav_flags': { data: [c.navFlags] },
    expense_claims: { data: c.hasExpenseClaims ? [{ id: 'claim-1' }] : [] },
    pos_connections: { data: c.hasPosConnection ? [{ id: 'pos-1' }] : [] },
    company_members: {
      data: { company_id: c.id, role: 'owner', companies: { archived_at: c.companies.archived_at, name: 'Representative' } },
    },
  }
}
