/**
 * Parties: the party behind a supplier or customer, as the v1 REST API and
 * the MCP server hand it to an agent.
 *
 * One shape for both surfaces: identity, where the party sits (roles,
 * status), the register's summary and what the ledger has seen. Read-only;
 * the write paths (promote, enrich, merge) stay in the app until the
 * parties resource lands in v1.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getDossier, type Dossier } from './register'
import { registrySummary, type RegistrySummary } from './registry-summary'

export interface PartyForApi {
  id: string
  display_name: string
  legal_name: string | null
  org_number: string | null
  vat_number: string | null
  /** ISO 3166-1 alpha-2 read out of vouchers or a register; null when unknown. */
  country: string | null
  kind: string
  status: 'confirmed' | 'suggested'
  roles: { supplier_id: string | null; customer_id: string | null }
  /** What SCB's company register says, or null when it was never asked. */
  registry: RegistrySummary | null
  /** What the ledger has seen under this party's keys in the dossier's period. */
  ledger: {
    occurrences: number
    expense_sek: number
    revenue_sek: number
    first_seen: string | null
    last_seen: string | null
    dominant_account: string | null
  } | null
  /** Payment identities seen on documents: bankgiro, plusgiro. */
  identities: Array<{ scheme: string; value: string; status: string; seen_count: number }>
}

export function partyForApi(dossier: Dossier): PartyForApi {
  const p = dossier.party
  const s = p.stats
  return {
    id: p.id,
    display_name: p.displayName,
    legal_name: p.legalName,
    org_number: p.orgNumber,
    vat_number: p.vatNumber,
    country: p.country,
    kind: p.kind,
    status: p.status,
    roles: { supplier_id: p.roles.supplierId, customer_id: p.roles.customerId },
    registry: registrySummary(dossier.facts),
    ledger: s
      ? {
          occurrences: s.occurrences,
          expense_sek: s.expenseSek,
          revenue_sek: s.revenueSek,
          first_seen: s.firstSeen,
          last_seen: s.lastSeen,
          dominant_account: s.dominantAccount ?? null,
        }
      : null,
    identities: dossier.identities.map((i) => ({ scheme: i.scheme, value: i.value, status: i.status, seen_count: i.seenCount })),
  }
}

/** The v1 REST schema of the party, for the OpenAPI spec and the agent skill. */
export const PartyForApiSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  legal_name: z.string().nullable(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  country: z.string().nullable(),
  kind: z.string(),
  status: z.enum(['confirmed', 'suggested']),
  roles: z.object({ supplier_id: z.string().uuid().nullable(), customer_id: z.string().uuid().nullable() }),
  registry: z
    .object({
      legal_name: z.string().nullable(),
      legal_form: z.string().nullable(),
      status: z.object({ label: z.string(), active: z.boolean() }).nullable(),
      warning: z.string().nullable(),
      registrations: z.object({ f_tax: z.boolean().nullable(), vat: z.boolean().nullable(), employer: z.boolean().nullable() }),
      industry: z.object({ code: z.string(), label: z.string() }).nullable(),
      seat: z.string().nullable(),
      registered_at: z.string().nullable(),
      active_since: z.string().nullable(),
      active_until: z.string().nullable(),
      employees_band: z.string().nullable(),
      turnover: z.object({ band: z.string(), year: z.string().nullable() }).nullable(),
      workplaces: z.number().nullable(),
      contact: z.object({
        email: z.string().nullable(),
        phone: z.string().nullable(),
        address: z.object({ co: z.string().nullable(), street: z.string().nullable(), postal_code: z.string().nullable(), city: z.string().nullable() }).nullable(),
      }),
      vat_number: z.string().nullable(),
      fetched_at: z.string().nullable(),
    })
    .nullable(),
  ledger: z
    .object({
      occurrences: z.number(),
      expense_sek: z.number(),
      revenue_sek: z.number(),
      first_seen: z.string().nullable(),
      last_seen: z.string().nullable(),
      dominant_account: z.string().nullable(),
    })
    .nullable(),
  identities: z.array(z.object({ scheme: z.string(), value: z.string(), status: z.string(), seen_count: z.number() })),
})

/** The party behind a row, for ?expand=party: null when the row has none or it was dismissed. */
export async function expandParty(supabase: SupabaseClient, companyId: string, partyId: string | null): Promise<PartyForApi | null> {
  if (!partyId) return null
  const dossier = await getDossier(supabase, companyId, partyId)
  return dossier ? partyForApi(dossier) : null
}
