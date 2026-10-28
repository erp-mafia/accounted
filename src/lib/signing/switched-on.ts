/**
 * Whether BankID document signing is switched on for a company,
 * synchronously: the SIGNING_ENABLED rollout and the BankID flag (always off
 * self-hosted). For surfaces resolved without a request round trip: the
 * sidebar's Signeringar entry (lib/navigation/nav-rollouts.ts) and the Att
 * göra rows of documents to sign (lib/worklist documents_to_sign). The doors
 * themselves ask signingAvailability() (./requests.ts), which also needs the
 * provider wired and the company's paid capability.
 * Pure env reads: safe in a module a client bundle can reach.
 */
import { isBankIdEnabled } from '@/lib/auth/bankid-flags'
import { signingEnabledFor } from '@/lib/env/signing-switch'

export function signingSwitchedOn(companyId: string | null | undefined): boolean {
  return signingEnabledFor(companyId) && isBankIdEnabled()
}
