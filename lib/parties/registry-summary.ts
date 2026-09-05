/**
 * Parties: the register's facts as one summary.
 *
 * SCB answers with twenty-odd coded columns. Three surfaces need them as
 * a few plain values: the Företagsuppgifter block on a supplier or customer
 * page, the v1 REST `party` expansion, and the MCP party tool. One reading
 * of the facts, so the three cannot drift. Pure: facts in, summary out.
 */

export interface RegistryFactLike {
  field: string
  value: unknown
  source: string
  fetchedAt?: string | null
}

export interface RegistryAddress {
  co: string | null
  street: string | null
  postal_code: string | null
  city: string | null
}

export interface RegistrySummary {
  legal_name: string | null
  legal_form: string | null
  /** SCB's company status: label and whether it means "active". */
  status: { label: string; active: boolean } | null
  /** Bolagsverket status only when it is a warning (likvidation, konkurs, ...). */
  warning: string | null
  registrations: { f_tax: boolean | null; vat: boolean | null; employer: boolean | null }
  industry: { code: string; label: string } | null
  seat: string | null
  registered_at: string | null
  active_since: string | null
  active_until: string | null
  employees_band: string | null
  turnover: { band: string; year: string | null } | null
  workplaces: number | null
  contact: { email: string | null; phone: string | null; address: RegistryAddress | null }
  vat_number: string | null
  fetched_at: string | null
}

type Coded = { code?: unknown; label?: unknown; warning?: unknown; year?: unknown }

function coded(value: unknown): Coded | null {
  return value && typeof value === 'object' ? (value as Coded) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Registered under SCB's coding: 1 registered, 3 via representant; 0 never, 9 deregistered. */
function registered(value: unknown): boolean | null {
  const code = text(coded(value)?.code)
  if (code === null) return null
  return code === '1' || code === '2' || code === '3'
}

/** The registry facts of a party as one summary, or null when the register has said nothing. */
export function registrySummary(facts: RegistryFactLike[]): RegistrySummary | null {
  const scb = facts.filter((f) => f.source === 'registry_scb')
  if (scb.length === 0) return null
  const get = (field: string) => scb.find((f) => f.field === field)?.value
  const status = coded(get('company_status'))
  const bolagsverket = coded(get('bolagsverket_status'))
  const industry = coded(get('industry'))
  const seat = get('seat') as { municipality?: string | null; county?: string | null } | undefined
  const turnover = coded(get('turnover_band'))
  const address = get('postal_address') as Partial<RegistryAddress> | undefined
  const fetchedAt = scb.map((f) => f.fetchedAt ?? null).filter((d): d is string => !!d).sort().at(-1) ?? null

  return {
    legal_name: text(get('legal_name')),
    legal_form: text(coded(get('legal_form'))?.label),
    status: status ? { label: text(status.label) ?? '', active: text(status.code) === '1' } : null,
    warning: bolagsverket?.warning === true ? (text(bolagsverket.label) ?? null) : null,
    registrations: { f_tax: registered(get('f_tax')), vat: registered(get('vat_registration')), employer: registered(get('employer_registration')) },
    industry: industry && text(industry.label) ? { code: text(industry.code) ?? '', label: text(industry.label) ?? '' } : null,
    seat: seat ? ([seat.municipality, seat.county].filter((x, i, arr): x is string => !!x && (i === 0 || x !== arr[0])).join(', ') || null) : null,
    registered_at: text(get('registered_at')),
    active_since: text(get('active_since')),
    active_until: text(get('active_until')),
    employees_band: text(coded(get('employees_band'))?.label),
    turnover: turnover && text(turnover.label) ? { band: text(turnover.label) ?? '', year: text(turnover.year) } : null,
    workplaces: typeof get('workplaces') === 'number' ? (get('workplaces') as number) : null,
    contact: {
      email: text(get('email')),
      phone: text(get('phone')),
      address:
        address && (text(address.street) || text(address.postal_code) || text(address.city))
          ? { co: text(address.co), street: text(address.street), postal_code: text(address.postal_code), city: text(address.city) }
          : null,
    },
    vat_number: text(get('vat_number')),
    fetched_at: fetchedAt,
  }
}

/**
 * How a registry address lands on a supplier or customer row. The c/o line
 * goes first, as Swedish post wants it; the street follows.
 */
export function addressRowsFromRegistry(address: RegistryAddress): { address_line1: string | null; address_line2: string | null; postal_code: string | null; city: string | null } {
  return address.co
    ? { address_line1: address.co, address_line2: address.street, postal_code: address.postal_code, city: address.city }
    : { address_line1: address.street, address_line2: null, postal_code: address.postal_code, city: address.city }
}

export interface ContactRow {
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Which contact fields to write on a row after a fetch. A field is filled
 * when it is empty, or when it still carries what the register said last
 * time (the person never touched it) and the register now says something
 * else. A value a person typed is never replaced.
 */
export function contactFill(row: ContactRow, now: RegistrySummary['contact'], before: RegistrySummary['contact'] | null): Partial<ContactRow> {
  const out: Partial<ContactRow> = {}
  const untouched = (current: string | null, previous: string | null | undefined) => !norm(current) || (previous != null && norm(current) === norm(previous))
  if (now.email && untouched(row.email, before?.email) && norm(row.email) !== norm(now.email)) out.email = now.email
  if (now.phone && untouched(row.phone, before?.phone) && norm(row.phone) !== norm(now.phone)) out.phone = now.phone
  if (now.address) {
    const next = addressRowsFromRegistry(now.address)
    const prev = before?.address ? addressRowsFromRegistry(before.address) : null
    const addressUntouched =
      untouched(row.address_line1, prev?.address_line1) &&
      untouched(row.address_line2, prev?.address_line2) &&
      untouched(row.postal_code, prev?.postal_code) &&
      untouched(row.city, prev?.city)
    const changed = (['address_line1', 'address_line2', 'postal_code', 'city'] as const).some((k) => norm(row[k]) !== norm(next[k]))
    if (addressUntouched && changed) Object.assign(out, next)
  }
  return out
}

/** True when the row's value is what the register said: shown as "från SCB". */
export function fromRegistry(rowValue: string | null | undefined, registryValue: string | null | undefined): boolean {
  return !!norm(rowValue) && norm(rowValue) === norm(registryValue)
}

/** "E-post, telefon och adress": a list the way Swedish (or English) joins it. */
export function listSv(items: string[], and: string): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`
}
