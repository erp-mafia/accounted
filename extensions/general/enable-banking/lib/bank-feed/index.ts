import type { BankFeedAdapter } from '@/lib/bank-feed/port'
import { getBankFeedAdapter, registerBankFeedAdapter, resolveBankFeed } from '@/lib/bank-feed/registry'
import { connectBankFeedAdapter } from './connect'
import { ENABLE_BANKING_PROVIDER, enableBankingDirectAdapter } from './direct'

/**
 * The Enable Banking extension contributes two bank feed adapters to the
 * ledger's registry: the direct one and the one over Accounted Connect (whose
 * bank operation is Enable Banking shaped, which is why it lives here rather
 * than in core). Both are always registered; the registry decides per
 * company which one answers. Idempotent, so any entry point may call it.
 */
export function ensureBankFeedAdapters(): void {
  if (!getBankFeedAdapter(ENABLE_BANKING_PROVIDER)) registerBankFeedAdapter(enableBankingDirectAdapter)
  if (!getBankFeedAdapter(connectBankFeedAdapter.provider)) registerBankFeedAdapter(connectBankFeedAdapter)
}

/** The adapter that serves this company. Throws when nothing is configured: a sync cannot half-run. */
export function selectBankFeedAdapter(companyId: string): BankFeedAdapter {
  ensureBankFeedAdapters()
  const resolved = resolveBankFeed(companyId)
  if (!resolved.adapter) throw new Error(`No bank feed adapter available (${resolved.reason})`)
  return resolved.adapter
}
