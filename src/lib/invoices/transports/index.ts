/**
 * Registers the Peppol Access Point adapters that the environment configures.
 * Core ships the Qvalia adapter; `PEPPOL_TRANSPORT_PROVIDER` still decides
 * which registered adapter the product is allowed to use, so an adapter can be
 * configured (for the probe script, for a preview) without being switched on.
 */

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { peppolConnectorMode } from '@/lib/connect/instance/upstreams'
import {
  CONNECTOR_PEPPOL_PROVIDER,
  getPeppolTransport,
  registerPeppolTransport,
  type PeppolParticipant,
  type PeppolTransport,
} from '@/lib/invoices/peppol-transport'
import { createConnectorPeppolTransport } from '@/lib/invoices/transports/connector'

/**
 * The hosted connector binds submissions and registrations to the instance
 * company that made them. PeppolTransport's read methods carry no tenant, so
 * the instance looks the company up in its own tables before each call.
 */
async function connectorCompanyForSubmission(providerSubmissionId: string): Promise<string | null> {
  const { data } = await createServiceClientNoCookies()
    .from('peppol_deliveries')
    .select('company_id')
    .eq('provider', CONNECTOR_PEPPOL_PROVIDER)
    .eq('provider_submission_id', providerSubmissionId)
    .limit(1)
    .maybeSingle()
  return (data as { company_id: string } | null)?.company_id ?? null
}

async function connectorCompanyForParticipant(participant: PeppolParticipant): Promise<string | null> {
  const { data } = await createServiceClientNoCookies()
    .from('peppol_registrations')
    .select('company_id')
    .eq('provider', CONNECTOR_PEPPOL_PROVIDER)
    .eq('participant_scheme', participant.scheme)
    .eq('participant_identifier', participant.identifier.replace(/\s/g, ''))
    .in('status', ['pending', 'registered'])
    .limit(1)
    .maybeSingle()
  return (data as { company_id: string } | null)?.company_id ?? null
}
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

  // Self-hosted instance in connector mode (connector key, no own Qvalia
  // keys): reach Arcim's access point through the hosted proxy. Hosted has
  // its own keys, so peppolConnectorMode() is null there and nothing changes.
  if (!getPeppolTransport(CONNECTOR_PEPPOL_PROVIDER)) {
    const connector = peppolConnectorMode()
    if (connector) {
      const transport = createConnectorPeppolTransport(connector, {
        companyFor: connectorCompanyForSubmission,
        companyForParticipant: connectorCompanyForParticipant,
      })
      registerPeppolTransport(transport)
      registered.push(transport)
    }
  }

  return registered
}
