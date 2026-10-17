/**
 * The bank-line ingest matchers ingestTransactions runs on every new row (and
 * the re-read passes on a re-read one), in this order: a hand-written static
 * list, no lazy registration, no lib/init, no event bus. Each matcher lives
 * with the block that owns it; the contract is lib/transactions/ingest-matcher.ts.
 *
 * Every matcher runs for every company, as before the list existed: nothing
 * here reads a package switch.
 */
import type { IngestMatcher } from '@/lib/transactions/ingest-matcher'
import { customerInvoiceIngestMatcher } from '@/lib/invoices/customer-invoice-ingest-matcher'
import { paymentOrderIngestMatcher } from '@/lib/payments/orders/ingest-matcher'
import { supplierInvoiceIngestMatcher } from '@/lib/invoices/supplier-invoice-ingest-matcher'
import { rotRutPayoutIngestMatcher, rotRutPayoutSetIngestMatcher } from '@/lib/invoices/rot-rut-ingest-matchers'
import { collectionsSweepIngestMatcher } from '@/lib/collections/ingest-matcher'

export const INGEST_MATCHERS: readonly IngestMatcher[] = Object.freeze([
  customerInvoiceIngestMatcher,
  paymentOrderIngestMatcher,
  supplierInvoiceIngestMatcher,
  rotRutPayoutIngestMatcher,
  rotRutPayoutSetIngestMatcher,
  collectionsSweepIngestMatcher,
] as IngestMatcher[])
