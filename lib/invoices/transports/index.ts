/**
 * Registers the Peppol Access Point adapters that the environment configures.
 * Core ships the Qvalia adapter; `PEPPOL_TRANSPORT_PROVIDER` still decides
 * which registered adapter the product is allowed to use, so an adapter can be
 * configured (for the probe script, for a preview) without being switched on.
 */

import {
  getPeppolTransport,
  registerPeppolTransport,
  type PeppolTransport,
} from '@/lib/invoices/peppol-transport'
import {
  QVALIA_PROVIDER,
  createQvaliaTransport,
  readQvaliaConfigFromEnv,
} from '@/lib/invoices/transports/qvalia'

export function registerConfiguredPeppolTransports(
  env: Record<string, string | undefined> = process.env,
): PeppolTransport[] {
  const registered: PeppolTransport[] = []

  if (!getPeppolTransport(QVALIA_PROVIDER)) {
    const qvaliaConfig = readQvaliaConfigFromEnv(env)
    if (qvaliaConfig) {
      const transport = createQvaliaTransport(qvaliaConfig)
      registerPeppolTransport(transport)
      registered.push(transport)
    }
  }

  return registered
}
