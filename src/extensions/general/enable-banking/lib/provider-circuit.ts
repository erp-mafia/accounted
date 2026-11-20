/**
 * The circuit breaker of one bank sync cron run against Enable Banking being
 * gone early.
 *
 * When the contract with Enable Banking ends, every call answers a
 * credential-level 401/403 (api-client.ts isCredentialRejection): not one
 * consent, the application. A run that kept going would spend a provider
 * call per connection and leave a few hundred identical failures behind.
 * This module reads the first two connections a run tries: when both were
 * refused at the credential level, the circuit trips, the run starts no
 * further connection, nothing is written on any row, and the route logs one
 * warn line with the count it skipped and reports providerUnavailable.
 *
 * Only the credential error counts. A dead consent (SessionExpiredError, a
 * 401/403 naming the session), a bank refusing (AspspUnavailableError), a
 * connector hop failing (ConnectorSyncError) and every other failure are
 * about one connection and never trip it. Pure: the route feeds it outcomes.
 */
import { ProviderCredentialError } from './api-client'

/** How many of the first connections tried must be refused at the credential level before the run stops. */
export const CREDENTIAL_TRIP_ATTEMPTS = 2

export interface ProviderCircuit {
  /** Report one finished connection: the error it ended with, or null for a success. */
  record(error: unknown | null): void
  /** The first CREDENTIAL_TRIP_ATTEMPTS connections were all refused at the credential level: start nothing more. */
  readonly tripped: boolean
  /** Connections finished so far, successes included. */
  readonly attempts: number
  /** Connections that ended with a credential-level refusal, over the whole run. */
  readonly credentialFailures: number
}

/** Whether a sync failure is Enable Banking (or the connector) refusing the application's credentials. */
export function isCredentialRejectionError(error: unknown): error is ProviderCredentialError {
  return error instanceof ProviderCredentialError
}

export function createProviderCircuit(): ProviderCircuit {
  const firstOutcomes: boolean[] = []
  let attempts = 0
  let credentialFailures = 0
  return {
    record(error) {
      attempts++
      const refused = error !== null && isCredentialRejectionError(error)
      if (refused) credentialFailures++
      if (firstOutcomes.length < CREDENTIAL_TRIP_ATTEMPTS) firstOutcomes.push(refused)
    },
    get tripped() {
      return firstOutcomes.length === CREDENTIAL_TRIP_ATTEMPTS && firstOutcomes.every(Boolean)
    },
    get attempts() {
      return attempts
    },
    get credentialFailures() {
      return credentialFailures
    },
  }
}
