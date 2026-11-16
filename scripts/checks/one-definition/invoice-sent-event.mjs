export default {
  rule: 'invoice-sent-event',
  says: 'invoice.sent is emitted by emitInvoiceSent, which adds what every receiver gets with it: the invoice at status sent and its payment reference.',
  home: 'src/lib/invoices/invoice-sent-event.ts: emitInvoiceSent',
  why: 'Nine emit sites behind five doors each built the payload from the row they happened to hold, so a field every webhook receiver should get (payment_reference, crm#1886) could not be added in one place.',
  match: [/type:\s*['"]invoice\.sent['"]/],
  sanctioned: ['lib/invoices/invoice-sent-event.ts'],
  allowed: {
    'lib/events/types.ts': 'The event in the union of core events: its type, not an emit.',
    'lib/webhooks/public-events.ts': 'The entry of the public webhook catalogue: which events are delivered, not an emit.',
  },
}
