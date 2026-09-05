/**
 * Registry facts as the dossier and the supplier and customer pages show
 * them: which SCB fields, in what order, with what label, and how a coded
 * or composite value prints. One module so the three surfaces cannot drift.
 */
import type { ReactNode } from 'react'
import type { Dossier } from '@/lib/parties/register'

export const REGISTRY_FIELDS = [
  'f_tax',
  'vat_registration',
  'employer_registration',
  'company_status',
  'legal_form',
  'bolagsverket_status',
  'employees_band',
  'turnover_band',
  'industry',
  'postal_address',
  'seat',
  'registered_at',
  'active_since',
  'active_until',
  'phone',
  'email',
  'workplaces',
  'trade_name',
] as const

/** Live registry facts, in the order the dossier shows them; the VAT number sits in its own row above. */
export function registryFacts(facts: Dossier['facts']): Dossier['facts'] {
  const scb = facts.filter((f) => f.source === 'registry_scb')
  return REGISTRY_FIELDS.flatMap((field) => scb.filter((f) => f.field === field))
}

export function registryLabel(t: (k: string) => string, field: string): string {
  return REGISTRY_FIELDS.includes(field as (typeof REGISTRY_FIELDS)[number]) ? t(`fact_${field}`) : field
}

/** Coded facts show their label; address and seat compose; the rest print. */
export function registryValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return '·'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const v = value as Record<string, unknown>
  if (typeof v.label === 'string') {
    const label = typeof v.year === 'string' && v.year ? `${v.label} (${v.year})` : v.label
    return v.warning ? <span className="text-warning">{label}</span> : label
  }
  if ('street' in v || 'city' in v) {
    return [v.co, v.street, [v.postal_code, v.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  }
  if ('municipality' in v || 'municipality_code' in v) {
    const parts = [v.municipality ?? v.municipality_code, v.county ?? v.county_code].filter(Boolean) as string[]
    // "Stockholm, Stockholm": the county adds nothing when it repeats the municipality.
    return parts.filter((x, i) => i === 0 || x !== parts[0]).join(', ')
  }
  if ('code' in v) return String(v.code)
  return JSON.stringify(v)
}
