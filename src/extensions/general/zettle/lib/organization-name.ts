/**
 * Display name for a Zettle connection. Zettle's users/self only returns
 * organizationUuid, so Accounted stores a human label in
 * zettle_connections.organization_name and copies it to
 * webshop_orders.store_label on sync / rename.
 */

export const ZETTLE_DEFAULT_ORGANIZATION_NAME = 'Zettle'
export const ZETTLE_ORGANIZATION_NAME_MAX_LEN = 80

/**
 * Human label for Orders "Butik" and settings. Never falls back to the org
 * UUID: that is an opaque identifier, not a store name.
 */
export function zettleStoreDisplayName(organizationName: string | null | undefined): string {
  const trimmed = typeof organizationName === 'string' ? organizationName.trim() : ''
  return trimmed.length > 0 ? trimmed : ZETTLE_DEFAULT_ORGANIZATION_NAME
}

/**
 * Trim and validate a rename payload. Empty after trim is rejected (clearing
 * would fall the Orders "Butik" column back to the organization UUID).
 */
export function parseZettleOrganizationName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'organization_name (string) krävs.' }
  }
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name.length === 0) {
    return { ok: false, error: 'Ange ett butiksnamn.' }
  }
  if (name.length > ZETTLE_ORGANIZATION_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `Butiksnamnet får vara högst ${ZETTLE_ORGANIZATION_NAME_MAX_LEN} tecken.`,
    }
  }
  return { ok: true, name }
}
