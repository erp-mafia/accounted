/**
 * Kivra and Billo sandbox probe: the first live contact with each API,
 * through the same adapters the app uses (src/lib/digital-mailboxes).
 *
 * Reads KIVRA_* and BILLO_* from the environment (npx dotenv -e <file>, or
 * export) and runs one of:
 *
 *   npx tsx scripts/digital-mailboxes/probe.ts kivra-companies [orgnr]
 *       Partner API: token, then the company key for an organisationsnummer
 *       (default: Kivra's sandbox test company), i.e. whether that company
 *       has activated Accounted at Kivra.
 *   npx tsx scripts/digital-mailboxes/probe.ts kivra-inbox <companyKey>
 *       Partner API: lists the company's content (keys, dates, subjects).
 *   npx tsx scripts/digital-mailboxes/probe.ts kivra-match <tenantKey> <orgnr|personnummer>
 *       Tenant API: whether the recipient is reachable from the tenant.
 *   npx tsx scripts/digital-mailboxes/probe.ts billo-token
 *       Partner API: exchanges the API key and prints the granted scope.
 *   npx tsx scripts/digital-mailboxes/probe.ts billo-sender-token
 *       Sender API: client credentials token, prints the granted scope.
 *
 * Read-only; nothing touches Accounted's database. Refuses to run against a
 * production environment. Credentials are never printed.
 */
import { providerRequest } from '@/lib/digital-mailboxes/http'
import { personnummer12 } from '@/lib/digital-mailboxes/identifiers'
import { buildDigitalMailboxProviders } from '@/lib/digital-mailboxes/providers'

const KIVRA_SANDBOX_TEST_COMPANY = '4420059208'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const providers = buildDigitalMailboxProviders(process.env)

  if (providers.kivra?.config.environment === 'production' || providers.billo?.config.environment === 'production') {
    throw new Error('The probe runs against the sandboxes only.')
  }

  switch (command) {
    case 'kivra-companies': {
      const receiver = providers.kivra?.receiver
      if (!receiver) throw new Error('Set KIVRA_PARTNER_CLIENT_ID, KIVRA_PARTNER_CLIENT_SECRET and KIVRA_ONBOARDING_URL.')
      const orgNumber = args[0] ?? KIVRA_SANDBOX_TEST_COMPANY
      const key = await receiver.findCompanyKey(orgNumber)
      console.log(key ? `company ${orgNumber} has activated Accounted: company_key ${key}` : `company ${orgNumber} has not activated Accounted at Kivra`)
      return
    }
    case 'kivra-inbox': {
      const receiver = providers.kivra?.receiver
      if (!receiver || !args[0]) throw new Error('Usage: kivra-inbox <companyKey> (with the partner client set).')
      const listed = await receiver.listDocuments({ accountRef: args[0], mailboxRef: null }, null)
      console.log(`${listed.length} content item(s)`)
      for (const item of listed.slice(0, 20)) {
        const { document, files } = await receiver.getDocument({ accountRef: args[0], mailboxRef: null }, item.ref)
        console.log(`${item.ref}  ${item.receivedAt ?? '-'}  ${document.kind}  ${document.subject ?? ''}  ${files.length} file(s)`)
      }
      return
    }
    case 'kivra-match': {
      const sender = providers.kivra?.sender
      const [tenantKey, id] = args
      if (!sender || !tenantKey || !id) throw new Error('Usage: kivra-match <tenantKey> <orgnr|personnummer> (with KIVRA_CLIENT_ID/SECRET set).')
      const pnr = id.replace(/\D/g, '').length === 12 ? personnummer12(id) : null
      const reachable = await sender.isReachable(tenantKey, pnr ? { kind: 'person', personnummer: pnr } : { kind: 'company', orgNumber: id })
      console.log(reachable ? 'reachable' : 'not reachable')
      return
    }
    case 'billo-token': {
      const config = providers.billo?.config
      if (!config?.partnerApiKey) throw new Error('Set BILLO_PARTNER_API_KEY.')
      const res = await providerRequest('billo', {
        method: 'POST',
        url: `${config.hosts.partner}/v1/auth/token`,
        headers: { 'x-api-key': config.partnerApiKey },
        description: 'partner token',
      })
      const body = (res.json ?? {}) as { scope?: unknown; expiresIn?: unknown }
      console.log(`partner token issued: scope "${String(body.scope ?? '')}", expires in ${String(body.expiresIn ?? '?')} s`)
      return
    }
    case 'billo-sender-token': {
      const config = providers.billo?.config
      if (!config?.sender) throw new Error('Set BILLO_SENDER_CLIENT_ID and BILLO_SENDER_CLIENT_SECRET.')
      const res = await providerRequest('billo', {
        method: 'POST',
        url: config.hosts.identity,
        form: { grant_type: 'client_credentials', client_id: config.sender.clientId, client_secret: config.sender.clientSecret },
        description: 'sender token',
      })
      const body = (res.json ?? {}) as { scope?: unknown; expires_in?: unknown }
      console.log(`sender token issued: scope "${String(body.scope ?? '')}", expires in ${String(body.expires_in ?? '?')} s`)
      return
    }
    default:
      console.log('Commands: kivra-companies [orgnr] | kivra-inbox <companyKey> | kivra-match <tenantKey> <id> | billo-token | billo-sender-token')
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
