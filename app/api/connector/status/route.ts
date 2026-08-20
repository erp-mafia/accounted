import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isSelfHosted } from '@/lib/env/public-flags'
import { getConnectorConfig } from '@/lib/connect/instance/config'
import { bankConnectorMode, skatteverketConnectorMode } from '@/lib/connect/instance/upstreams'
import { CONNECTOR_CAPABILITIES } from '@/lib/entitlements/keys'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'

/**
 * GET /api/connector/status: the self-hosted operator's "is the connector
 * wired up" view. Reports whether a connector key is configured, which
 * upstreams are in connector mode (routed through the hosted proxy) vs run on
 * the instance's own credentials, and, for the caller's own company, which
 * connector capabilities are currently granted (written by the hourly sync).
 *
 * Hosted returns { self_hosted: false }: the connector product is a
 * self-host-only concept. Any authenticated member may read it; it exposes no
 * secret (never the key itself), only booleans and the key's non-secret prefix.
 */
export const GET = withRouteContext('connector.status', async (_request, { supabase, companyId }) => {
  if (!isSelfHosted()) {
    return NextResponse.json({ data: { self_hosted: false } })
  }
  const cfg = getConnectorConfig()
  const bank = bankConnectorMode()
  const skv = skatteverketConnectorMode()

  const grants = companyId
    ? await getConnectorGrantsFor(supabase, companyId)
    : []

  return NextResponse.json({
    data: {
      self_hosted: true,
      configured: !!cfg,
      connect_url: cfg?.baseUrl ?? null,
      key_prefix: cfg ? cfg.key.slice(0, 13) : null,
      upstreams: {
        bank: cfg ? (bank ? 'connector' : 'own_credentials') : 'unconfigured',
        skatteverket: cfg ? (skv ? 'connector' : 'own_credentials') : 'unconfigured',
      },
      granted_capabilities: grants,
    },
  })
})

async function getConnectorGrantsFor(
  supabase: Parameters<typeof getCompanyIdsWithCapability>[0],
  companyId: string,
): Promise<string[]> {
  const held: string[] = []
  for (const cap of CONNECTOR_CAPABILITIES) {
    const ids = await getCompanyIdsWithCapability(supabase, [companyId], cap)
    if (ids.has(companyId)) held.push(cap)
  }
  return held
}
