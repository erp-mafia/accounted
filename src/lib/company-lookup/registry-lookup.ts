import { createLogger } from '@/lib/logger'
import type { TicCallPurpose } from '@/lib/tic-budget/budget'
import { LOOKUP_COMPANY_SERVICE, type RegistryLookupOutcome } from './types'

const log = createLogger('company-lookup')

/**
 * A company in the public register by organisationsnummer, asked of the
 * extension that provides LOOKUP_COMPANY_SERVICE (the TIC extension): core
 * never imports extension code, so the provider is found in the extension
 * registry, as the company snapshot finds its profile
 * (lib/agent/composer/tic-fetch.ts). No provider (the extension switched off,
 * a self-hosted install without it) is unavailable: not_configured.
 *
 * `purpose` and `subject` are what the call is charged to in the lookup
 * budget (lib/tic-budget): the share and, for mcp_lookup, the daily cap per
 * subject.
 */
export async function lookupCompanyInRegistry(
  orgNumber: string,
  charge: { purpose: TicCallPurpose; subject: string | null },
): Promise<RegistryLookupOutcome> {
  // Loaded on use, as in tic-fetch.ts: a static registry import would pull
  // lib/init toward every importer of this module.
  const { extensionRegistry } = await import('@/lib/extensions/registry')
  const provider = (await extensionRegistry.getAll()).find(
    (ext) => typeof ext.services?.[LOOKUP_COMPANY_SERVICE] === 'function',
  )
  if (!provider) return { status: 'unavailable', reason: 'not_configured' }
  try {
    return (await provider.services![LOOKUP_COMPANY_SERVICE](orgNumber, charge)) as RegistryLookupOutcome
  } catch (err) {
    // The provider answers the register's own failures itself; anything it
    // throws (a reply it could not read, its own bug) is still the register
    // giving no answer to the caller. Logged, so a bug stays visible.
    log.error('registry lookup failed', { provider: provider.id, error: err instanceof Error ? err.message : String(err) })
    return { status: 'unavailable', reason: 'registry_error' }
  }
}
