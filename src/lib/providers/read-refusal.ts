import { ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget'
import { fetchCompanyInfoDirect } from './provider-data-fetcher'
import { ProviderCallError } from './with-provider-call'
import type { ProviderName } from './types'

/**
 * A provider 403 read against the token that drew it, with one
 * company-information call. A 403 alone cannot tell a dead grant from a
 * register or detail the token may not read: Bokio and Visma answer both
 * alike, and Fortnox names only some refusals with a code it documents. A
 * token that still answers is alive, so the 403 refused that resource
 * (DECISIONS.md 2026-10-11, crm#1081), and the error comes back as
 * PROVIDER_RESOURCE_FORBIDDEN. Anything else (not a 403, a token that no
 * longer answers, a failed call) returns the error unchanged. Running out of
 * time throws ExecutionBudgetExceeded. The caller decides which 403 needs
 * the reading.
 */
export async function readProviderRefusal(
  error: unknown,
  provider: ProviderName,
  connection: { accessToken: string; providerCompanyId?: string },
  deadline: number,
): Promise<unknown> {
  const { statusCode, status } = (error instanceof Error ? error : {}) as { statusCode?: unknown; status?: unknown }
  if ((statusCode ?? status) !== 403) return error
  try {
    const company = await withExecutionDeadline(deadline, 'provider-grant-probe',
      () => fetchCompanyInfoDirect(provider, connection.accessToken, connection.providerCompanyId))
    if (!company) return error
  } catch (probeError) {
    if (probeError instanceof ExecutionBudgetExceeded) throw probeError
    return error
  }
  return new ProviderCallError('PROVIDER_RESOURCE_FORBIDDEN', provider,
    'Provider refused a resource on a grant that still answers', { status: 403 })
}
