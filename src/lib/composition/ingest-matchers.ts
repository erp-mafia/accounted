/**
 * The bank-line ingest matchers ingestTransactions runs on every new row (and
 * the re-read passes on a re-read one), in this order: a hand-written static
 * list, no lazy registration, no lib/init, no event bus. Each matcher lives
 * with the block that owns it; the contract is lib/transactions/ingest-matcher.ts.
 *
 * Nothing here reads a package switch. Behind INGEST_PACKAGE_GATING (off),
 * ingest skips the matchers of a package that is switched off with nothing
 * open, by each matcher's module (lib/transactions/ingest-package-gate.ts);
 * otherwise every matcher runs for every company, as before the list existed.
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
