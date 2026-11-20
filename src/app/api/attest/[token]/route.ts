import { attestLinkJson, describeAttestLink, withAttestLinkToken } from '@/lib/supplier-invoices/attest-link-route'

/**
 * GET /api/attest/:token: what the attest mail's link shows, without a login:
 * the company, the invoice (supplier, number, dates, amount, whether there is
 * a PDF), who registered it, where the attest stands and whether this
 * attester may approve or reject it now.
 */
export const GET = withAttestLinkToken<{ token: string }>('attest_link.read', async (_request, { link, service, log }) => {
  return attestLinkJson(await describeAttestLink(service, link, log))
})
