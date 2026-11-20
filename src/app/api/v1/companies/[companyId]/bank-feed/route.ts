/**
 * GET /api/v1/companies/{companyId}/bank-feed: the company's Open Payments
 * bank connections (consent expiry, last sync, the accounts each reads) and
 * whether it may make one (operation bank-feed.overview).
 *
 * Contract, docs and rules live in src/lib/operations/bank-feed.ts. The
 * BankID consent itself has no door: a person signs it in Accounted or from
 * the signatory link (POST ./invites).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { bankFeedOverview } from '@/lib/operations/bank-feed'

export const GET = v1OperationHandler(bankFeedOverview)
