/**
 * POST /api/v1/companies/{companyId}/payments/signing-links: a signing link,
 * valid 72 hours, where someone without an Accounted login (the company's
 * firmatecknare) signs approved bank payments with BankID; optionally mailed
 * (operation payment-signing-links.create). Owners and admins, or the person
 * who prepared every order. ?dry_run=true answers the basket and mints nothing.
 *
 * Contract, docs and rules live in src/lib/operations/payment-signing-links.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { paymentSigningLinksCreate } from '@/lib/operations/payment-signing-links'

export const POST = v1OperationHandler(paymentSigningLinksCreate)
