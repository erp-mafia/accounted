import { CAPABILITY, type CapabilityKey } from './keys'

/**
 * Own-credentials seam for the connector partition, forward-ported from the
 * instance-wiring layer (lib/connect/instance/upstreams.ts in the connector
 * stack) so it lands WITH the partition, not four PRs later.
 *
 * A self-host that runs an upstream on its OWN credentials (its own Enable
 * Banking AISP registration, its own Skatteverket API client) provides that
 * service itself: it must never be connector-gated for it, exactly like every
 * other local capability. Without this seam, upgrading an own-credentials
 * self-host would silently kill working bank sync / SKV integrations (the
 * 2026-08-17 folded-flag incident, recreated deliberately).
 *
 * The env-var sets are the same ones the extensions activate on
 * (enable-banking manifest / jwt.ts; skatteverket manifest / api-client.ts)
 * and must stay in sync with the connector-mode seam when the instance-wiring
 * PR lands: connector mode = key present AND no own credentials.
 */

/** True when the instance would use its own Enable Banking credentials. */
export function hasOwnEnableBankingCredentials(): boolean {
  return !!(
    process.env.ENABLE_BANKING_PRIVATE_KEY_PRODUCTION ||
    process.env.ENABLE_BANKING_PRIVATE_KEY ||
    process.env.ENABLE_BANKING_APP_ID_PRODUCTION ||
    process.env.ENABLE_BANKING_APP_ID
  )
}

/** True when the instance would use its own Skatteverket OAuth client. */
export function hasOwnSkatteverketCredentials(): boolean {
  return !!(process.env.SKATTEVERKET_OAUTH2_CLIENT_ID || process.env.SKATTEVERKET_APIGW_CLIENT_ID)
}

/** True when the instance would use its own Peppol access point (Qvalia partner keys). */
export function hasOwnPeppolCredentials(): boolean {
  return !!(process.env.QVALIA_API_KEY || process.env.QVALIA_PARTNER_REG_NO)
}

/**
 * Whether this instance provides the given connector capability from its own
 * credentials. org_lookup and migration have no own-credentials form: they
 * run exclusively on services Accounted operates.
 */
export function hasOwnCredentialsFor(key: CapabilityKey): boolean {
  if (key === CAPABILITY.bank_sync) return hasOwnEnableBankingCredentials()
  if (key === CAPABILITY.skatteverket) return hasOwnSkatteverketCredentials()
  if (key === CAPABILITY.peppol) return hasOwnPeppolCredentials()
  return false
}
