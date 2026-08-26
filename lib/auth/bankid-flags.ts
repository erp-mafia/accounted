/**
 * BankID feature flag, kept free of Node imports.
 *
 * lib/auth/bankid.ts imports `crypto` for personnummer hashing and token
 * encryption; the flag alone is what the login, register and security
 * settings client components need. Importing it from there dragged
 * crypto-browserify, vm-browserify and Buffer (~327 KB uncompressed) into
 * those bundles.
 *
 * BankID is only available on the hosted deployment (requires TIC Identity
 * API). Self-hosted deployments never show the BankID option.
 */

import { flagEnabled, isSelfHosted } from '@/lib/env/public-flags'

export function isBankIdEnabled(): boolean {
  if (isSelfHosted()) return false
  return flagEnabled(process.env.NEXT_PUBLIC_BANKID_ENABLED)
}
