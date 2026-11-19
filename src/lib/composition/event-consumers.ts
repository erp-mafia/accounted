/**
 * The core event consumers: every reaction core has to an event, in one
 * static list. lib/init subscribes them (subscribeEventConsumers,
 * lib/events/consumers.ts); the enabled extensions add one consumer each
 * (`ext:<id>`, lib/extensions/registry.ts) after these.
 *
 * The order is the dispatch order on the bus: for an event several consumers
 * share, they start in this order and run concurrently, inline in the request
 * that emits (Promise.allSettled in lib/events/bus.ts).
 *
 * A consumer that can be delivered from the event outbox instead (step E3)
 * is declared in ./async-event-consumers.ts and listed here by reference.
 *
 * Adding a consumer changes which handlers run on which events, which
 * src/lib/events/__tests__/subscriptions.test.ts pins: record it there, and
 * in the consumer index the event bus reads (lib/events/consumer-index.ts,
 * kept fresh by consumer-index.test.ts).
 */
import { handleSupplierInvoiceRetroMatch } from '@/lib/invoices/supplier-invoice-handler'
import { unlearnOnReversal } from '@/lib/bookkeeping/handlers/unlearn-on-reversal'
import { cancelAccrualsOnOriginReversal } from '@/lib/bookkeeping/handlers/cancel-accruals-on-origin-reversal'
import { WEBHOOKS_EVENT_CONSUMER } from '@/lib/composition/async-event-consumers'
import { eventConsumer, type EventConsumer } from '@/lib/events/consumers'
import { relayAgentFeedback } from '@/lib/events/handlers/agent-feedback-relay-handler'
import { endBankFeedsOfDeletedCompany } from '@/lib/events/handlers/company-deleted-bank-feed-handler'
import { enqueueDocumentRead } from '@/lib/events/handlers/document-read-handler'
import { proposeInboxBankMatches } from '@/lib/events/handlers/inbox-bank-match-handler'
import { realiseForecastRowsOnArrival } from '@/lib/events/handlers/forecast-realise-handler'
import { followReceiptOnSupplierPayment } from '@/lib/events/handlers/inbox-companion-handler'
import { PERSISTED_EVENT_TYPES, writeEventLog } from '@/lib/events/handlers/event-log-handler'
import { detectorsByEventType, runEventDetectors } from '@/lib/suggestions/handler'
import { handleSupplierInvoiceRegistered } from '@/lib/supplier-invoices/attest-notify'

const SUGGESTION_DETECTORS = detectorsByEventType()

export const EVENT_CONSUMERS: readonly EventConsumer[] = Object.freeze([
  // A registered or approved supplier invoice is matched against the bank
  // payments already imported (a proposal; it never books).
  eventConsumer({
    id: 'supplier-invoice-retro-match',
    owner: 'supplier-invoices',
    eventTypes: ['supplier_invoice.registered', 'supplier_invoice.approved'],
    handle: (event) => handleSupplierInvoiceRetroMatch(event.payload),
  }),
  // A reversed bank booking takes back the counterpart template it taught.
  eventConsumer({
    id: 'unlearn-on-reversal',
    owner: 'transactions',
    eventTypes: ['journal_entry.reversed'],
    handle: (event) => unlearnOnReversal(event.payload),
  }),
  // A reversed verifikat cancels the manual periodiseringar it is the origin
  // of and stornoes the months they posted, as a credit does for an invoice.
  eventConsumer({
    id: 'accrual-origin-reversal',
    owner: 'ledger',
    eventTypes: ['journal_entry.reversed'],
    handle: (event) => cancelAccrualsOnOriginReversal(event.payload),
  }),
  // The attest mail to each attester when an invoice that needs attest is registered.
  eventConsumer({
    id: 'attest-notify',
    owner: 'supplier-invoices',
    eventTypes: ['supplier_invoice.registered'],
    handle: (event) => handleSupplierInvoiceRegistered(event.payload),
  }),
  // event_log, which GET /api/events serves: every public webhook event plus
  // the internal ones external automation and the weekly loops read.
  eventConsumer({
    id: 'event-log',
    owner: 'platform',
    eventTypes: PERSISTED_EVENT_TYPES,
    handle: (event) => writeEventLog(event.type, event.payload),
  }),
  // Every uploaded document gets a read job (Arkiv).
  eventConsumer({
    id: 'document-read',
    owner: 'inbox',
    eventTypes: ['document.uploaded'],
    handle: (event) => enqueueDocumentRead(event.payload),
  }),
  // Match on arrival, the bank's side: arriving bank rows are offered to the
  // open inbox items they could pay, as a proposal a person confirms (a row
  // the ingest matchers claimed is never proposed).
  eventConsumer({
    id: 'inbox-bank-match',
    owner: 'inbox',
    eventTypes: ['transaction.synced'],
    handle: (event) => proposeInboxBankMatches(event.payload),
  }),
  // Actuals replace forecasts: an arriving bank row that pays an open
  // liquidity forecast row marks it realised, so the money is not counted
  // again in the projection (lib/forecast/realise.ts). Never books.
  eventConsumer({
    id: 'forecast-realise',
    owner: 'ledger',
    eventTypes: ['transaction.synced'],
    handle: (event) => realiseForecastRowsOnArrival(event.payload),
  }),
  // The receipt follows its invoice: a supplier invoice registered from an
  // inbox item that came with its receipt is settled against a bank row, and
  // the receipt becomes an underlag of the payment's verifikat.
  eventConsumer({
    id: 'inbox-receipt-follow',
    owner: 'inbox',
    eventTypes: ['supplier_invoice.match_confirmed'],
    handle: (event) => followReceiptOnSupplierPayment(event.payload),
  }),
  // An agent's gnubok_feedback report becomes a support ticket.
  eventConsumer({
    id: 'agent-feedback-relay',
    owner: 'agent',
    eventTypes: ['agent.feedback'],
    handle: (event) => relayAgentFeedback(event.payload),
  }),
  // A deleted company's Open Payments connections are disconnected and their
  // consents ended at the bank, as a person's disconnect does: nobody can
  // reach them once the company is hidden, and each live consent is billed.
  eventConsumer({
    id: 'deleted-company-bank-feeds',
    owner: 'bank-feed',
    eventTypes: ['company.deleted'],
    handle: (event) => endBankFeedsOfDeletedCompany(event.payload),
  }),
  // One webhook_deliveries row per matching webhook of the company. Declared
  // with the consumers the outbox dispatcher may run (./async-event-consumers.ts):
  // EVENT_DELIVERY_WEBHOOKS=outbox moves it there.
  WEBHOOKS_EVENT_CONSUMER,
  // Suggestion detectors (lib/suggestions): the events that can call for a
  // package switch (an employee registered, a till or webshop connected)
  // stage it for a person to approve. Never an automatic change.
  eventConsumer({
    id: 'suggestion-detectors',
    owner: 'platform',
    eventTypes: [...SUGGESTION_DETECTORS.keys()],
    handle: (event) => runEventDetectors(event, SUGGESTION_DETECTORS.get(event.type) ?? []),
  }),
])
