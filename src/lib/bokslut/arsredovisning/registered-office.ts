/**
 * The säte the annual report prints: on the cover ("Säte: ..."), in
 * förvaltningsberättelsen ("Bolaget har sitt säte i ...", K2 punkt 4.9
 * "Verksamheten (art och inriktning, säte)"), and as the place on the
 * underskrifter and fastställelseintyg lines.
 *
 * The source is `company_settings.registered_office` (SCB Säteskommun at
 * creation, editable in Settings). Companies created before that column
 * existed have none yet, and the register value cannot be backfilled by a
 * migration. For them the founder's default (2026-10-03) is to fall back to
 * `city`, the postal town, with a warning asking the user to check it.
 *
 * To block the annual report until säte is filled instead, set
 * REGISTERED_OFFICE_FALLS_BACK_TO_CITY to false: the säte then resolves to
 * null and completeness raises AR-COMPANY-REGISTERED-OFFICE as an error,
 * which stops finalising, signing and filing.
 */
export const REGISTERED_OFFICE_FALLS_BACK_TO_CITY = true

export interface ResolvedRegisteredOffice {
  /** What the report prints as säte; null when unknown. */
  value: string | null
  /** True when `value` is the postal town standing in for a missing säte. */
  fromCity: boolean
}

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

export function resolveRegisteredOffice(
  settings: { registered_office?: string | null; city?: string | null } | null | undefined,
  fallbackToCity: boolean = REGISTERED_OFFICE_FALLS_BACK_TO_CITY,
): ResolvedRegisteredOffice {
  const registered = text(settings?.registered_office)
  if (registered) return { value: registered, fromCity: false }
  const city = fallbackToCity ? text(settings?.city) : null
  return city ? { value: city, fromCity: true } : { value: null, fromCity: false }
}

/** The warning shown while the postal town stands in for säte. */
export function registeredOfficeFallbackWarning(city: string): string {
  return `Säte saknas i företagsinställningarna, så orten i postadressen (${city}) används som säte i årsredovisningen. Kontrollera att det är företagets registrerade säte och ange sätet under Inställningar → Företag.`
}
