/**
 * POST /api/v1/companies/{companyId}/bank-feed/invites: a signatory link,
 * valid 7 days, where the company's firmatecknare connects, switches or
 * renews the bank with BankID through Open Payments without an Accounted
 * login; optionally mailed (operation bank-feed.invite). Owners and admins
 * only. ?dry_run=true answers the preview and mints nothing.
 *
 * Contract, docs and rules live in src/lib/operations/bank-feed.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { bankFeedInvite } from '@/lib/operations/bank-feed'

export const POST = v1OperationHandler(bankFeedInvite)
