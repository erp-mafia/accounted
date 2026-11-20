import { attestLinkJson } from '@/lib/supplier-invoices/attest-link-route'
import { describeAttestBatch, withAttestBatchToken } from '@/lib/supplier-invoices/attest-batch-route'

/**
 * GET /api/attest/lista/:token: what the batched attest mail's link shows,
 * without a login: the company and every invoice the mail listed (supplier,
 * number, dates, amount, whether there is a document, who registered it)
 * with what this attester may do with each one now.
 */
export const GET = withAttestBatchToken<{ token: string }>('attest_batch.read', async (_request, { batch, service }) => {
  return attestLinkJson(await describeAttestBatch(service, batch))
})
