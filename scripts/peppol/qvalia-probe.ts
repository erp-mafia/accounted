/**
 * Qvalia sandbox probe: the first live contact with the Access Point.
 *
 * Reads QVALIA_* from the environment (npx dotenv -e .env.local, or export)
 * and runs one of:
 *
 *   npx tsx scripts/peppol/qvalia-probe.ts auth
 *       Exchanges the API key for a JWT (GET /token/{partnerRegNo}) with both
 *       header schemes, so we learn which one this key accepts.
 *   npx tsx scripts/peppol/qvalia-probe.ts lookup 0007:5567321707
 *       Recipient lookup through the adapter (Qvalia's own id by default).
 *   npx tsx scripts/peppol/qvalia-probe.ts accounts
 *       Lists child accounts under the partner (tells us consolidated vs
 *       multi-tenant as Qvalia set it up).
 *   npx tsx scripts/peppol/qvalia-probe.ts peppol-ids
 *       Lists the Peppol identifiers registered on the partner account.
 *   npx tsx scripts/peppol/qvalia-probe.ts outgoing
 *       Lists the three latest outgoing invoice statuses (read-only).
 *   npx tsx scripts/peppol/qvalia-probe.ts incoming [integrationId]
 *       Lists the latest incoming invoice statuses, or prints one incoming
 *       invoice as XML (read-only: uses the non-marking endpoint).
 *   npx tsx scripts/peppol/qvalia-probe.ts send path/to/invoice.xml
 *       Submits a BIS Billing 3 XML through the adapter. Sandbox only: the
 *       script refuses a production base URL.
 *   npx tsx scripts/peppol/qvalia-probe.ts webhook
 *       Shows the partner webhook subscription (URL, event types, auth type).
 *   npx tsx scripts/peppol/qvalia-probe.ts webhook-configure https://host/api/webhooks/peppol/qvalia
 *       Creates or updates the partner webhook subscription for all three
 *       event types and attaches QVALIA_WEBHOOK_SECRET as the api_key header
 *       (QVALIA_WEBHOOK_HEADER) that our route verifies. Requires the secret
 *       in the environment; prints the webhook id.
 *
 * Nothing here touches Accounted's database. The API key is never printed.
 */

import { readFileSync } from 'node:fs'
import {
  QVALIA_PRODUCTION_BASE_URL,
  createQvaliaTransport,
  readQvaliaConfigFromEnv,
} from '@/lib/invoices/transports/qvalia'
import {
  PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '@/lib/invoices/peppol-bis-billing'
import { sha256Hex } from '@/lib/invoices/peppol-delivery'

const [, , command = 'auth', argument] = process.argv

const config = readQvaliaConfigFromEnv()
if (!config) {
  console.error('Set QVALIA_API_KEY, QVALIA_PARTNER_REG_NO and QVALIA_BASE_URL first (see .env.example).')
  process.exit(2)
}
const partner = encodeURIComponent(config.partnerRegNo)
const account = encodeURIComponent(config.accountRegNo)

function headerFor(scheme: 'apikey' | 'raw'): string {
  return scheme === 'raw' ? config!.apiKey : `ApiKey ${config!.apiKey}`
}

async function show(label: string, response: Response): Promise<unknown> {
  const text = await response.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* keep text */ }
  console.log(`\n== ${label}: HTTP ${response.status}`)
  const integrationId = response.headers.get('integrationid')
  if (integrationId) console.log(`integrationid header: ${integrationId}`)
  console.log(typeof body === 'string' ? body.slice(0, 2000) : JSON.stringify(body, null, 2).slice(0, 4000))
  return body
}

async function rawGet(path: string, scheme: 'apikey' | 'raw' = config!.authScheme): Promise<Response> {
  return fetch(`${config!.baseUrl}${path}`, {
    headers: { Authorization: headerFor(scheme), accept: 'application/json' },
  })
}

async function rawSend(method: 'PUT' | 'POST', path: string, body: unknown): Promise<Response> {
  return fetch(`${config!.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: headerFor(config!.authScheme),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function main(): Promise<void> {
  console.log(`Qvalia probe against ${config!.baseUrl} as partner ${config!.partnerRegNo} (account ${config!.accountRegNo})`)

  switch (command) {
    case 'auth': {
      for (const scheme of ['apikey', 'raw'] as const) {
        await show(`GET /token/{partnerRegNo} with Authorization scheme "${scheme}"`, await rawGet(`/token/${partner}`, scheme))
      }
      return
    }
    case 'accounts': {
      await show('GET /partner/{p}/account', await rawGet(`/partner/${partner}/account?limit=25`))
      return
    }
    case 'peppol-ids': {
      await show('GET /partner/{p}/account/{a}/peppol', await rawGet(`/partner/${partner}/account/${account}/peppol`))
      return
    }
    case 'outgoing': {
      await show(
        'GET /partner/{p}/transaction/{a}/invoices/outgoing/status',
        await rawGet(`/partner/${partner}/transaction/${account}/invoices/outgoing/status?includeRead=true&limit=3`),
      )
      return
    }
    case 'incoming': {
      if (argument) {
        const response = await fetch(
          `${config!.baseUrl}/partner/${partner}/transaction/${account}/invoices/incoming?integrationId=${encodeURIComponent(argument)}&includeRead=true&limit=1`,
          { headers: { Authorization: headerFor(config!.authScheme), accept: 'application/xml' } },
        )
        console.log(`HTTP ${response.status}`)
        console.log((await response.text()).slice(0, 6000))
        return
      }
      await show(
        'GET /partner/{p}/transaction/{a}/invoices/incoming/status',
        await rawGet(`/partner/${partner}/transaction/${account}/invoices/incoming/status?includeRead=true&limit=5`),
      )
      return
    }
    case 'webhook': {
      await show('GET /partner/{p}/webhook/configure', await rawGet(`/partner/${partner}/webhook/configure`))
      return
    }
    case 'webhook-configure': {
      if (!argument || !/^https:\/\//.test(argument)) {
        throw new Error('webhook-configure expects an https URL, e.g. https://app.accounted.se/api/webhooks/peppol/qvalia')
      }
      if (!config!.webhookSecret) throw new Error('Set QVALIA_WEBHOOK_SECRET first (openssl rand -hex 32)')
      const configured = await show(
        'PUT /partner/{p}/webhook/configure',
        await rawSend('PUT', `/partner/${partner}/webhook/configure`, {
          url: argument,
          types: ['new_document', 'document_delivery', 'document_error'],
        }),
      )
      const webhookId = configured && typeof configured === 'object' && 'id' in configured
        ? String((configured as { id: unknown }).id)
        : null
      if (!webhookId) throw new Error('Qvalia did not return a webhook id')
      await show(
        'POST /partner/{p}/webhook/{id}/auth (api_key header)',
        await rawSend('POST', `/partner/${partner}/webhook/${encodeURIComponent(webhookId)}/auth`, {
          type: 'api_key',
          header: config!.webhookHeader,
          value: config!.webhookSecret,
        }),
      )
      return
    }
    case 'lookup': {
      const peppolId = argument ?? '0007:5567321707'
      const [scheme, identifier] = peppolId.split(':')
      if (!scheme || !identifier) throw new Error('lookup expects scheme:identifier, e.g. 0007:5567321707')
      const transport = createQvaliaTransport(config!)
      console.log(JSON.stringify(await transport.lookupRecipient({ scheme, identifier }), null, 2))
      return
    }
    case 'send': {
      if (config!.baseUrl === QVALIA_PRODUCTION_BASE_URL) {
        throw new Error('Refusing to send through the probe against production. Use the product flow.')
      }
      if (!argument) throw new Error('send expects a path to a BIS Billing 3 XML file')
      const xml = readFileSync(argument, 'utf8')
      const sender = /AccountingSupplierParty[\s\S]*?<cbc:EndpointID schemeID="(\d{4})">([^<]+)</.exec(xml)
      const recipient = /AccountingCustomerParty[\s\S]*?<cbc:EndpointID schemeID="(\d{4})">([^<]+)</.exec(xml)
      if (!sender || !recipient) throw new Error('Could not read EndpointID for seller and buyer from the XML')
      const transport = createQvaliaTransport(config!)
      const receipt = await transport.submit({
        idempotencyKey: crypto.randomUUID(),
        tenantReference: 'probe',
        sender: { scheme: sender[1], identifier: sender[2] },
        recipient: { scheme: recipient[1], identifier: recipient[2] },
        documentTypeId: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
        processId: PEPPOL_BIS_BILLING_PROFILE_ID,
        filename: argument.split('/').pop() ?? 'invoice.xml',
        contentType: 'application/xml',
        document: xml,
        documentSha256: sha256Hex(xml),
      })
      console.log(JSON.stringify(receipt, null, 2))
      console.log('\nEvidence after submit:')
      console.log(JSON.stringify(await transport.retrieveEvidence(receipt.providerSubmissionId), null, 2).slice(0, 4000))
      return
    }
    default:
      throw new Error(`Unknown command "${command}". See the header comment for the list.`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  if (error && typeof error === 'object' && 'detail' in error) {
    console.error('detail:', (error as { detail?: unknown }).detail)
  }
  process.exit(1)
})
