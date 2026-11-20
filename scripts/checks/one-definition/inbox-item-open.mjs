export default {
  rule: 'inbox-item-open',
  says: 'Whether an inbox item is still open comes from one definition over its links, Arkiv routing and whether a verifikat already holds its document.',
  home: 'src/lib/documents/inbox-item-state.ts: isOpenInboxItem, whereInboxItemOpen',
  why: 'Eleven readers wrote it by hand: a document on a verifikat read as open in the Inkorg and processed over MCP, and routed items counted in the client overview and not on Hem, so the Inkorg offered booked documents for booking again.',
  match: [
    // The columns of the reading as a filter, or as a predicate.
    /\.is\('matched_transaction_id', null\)/,
    /!\w+\.matched_transaction_id && !\w+\.created_/,
    /!\w+\.created_\w+ && !\w+\.created_\w+ && !\w+\.routed_to_arkiv_at/,
  ],
  sanctioned: ['lib/documents/inbox-item-state.ts'],
  allowed: {
    'extensions/general/mcp-server/resources/attention.ts': 'the receipts table, not inbox items.',
    'lib/payments/orders/auto-settle.ts': 'a payment order linked to its debit, not an inbox item.',
    'lib/payments/orders/sync.ts': 'a payment order linked to its debit, not an inbox item.',
    'lib/transactions/document-attach.ts': 'the back-link of one item to one row: an item Arkiv took or a verifikat holds may still point at the row.',
    'extensions/general/mcp-server/server.ts': 'the bulk booking preflight sorts items by what it can do with them, and matched items are what it books.',
    'lib/core/documents/document-service.ts': 'the delete of an item its document alone stood for repeats the columns: lib/core takes no new import (kernel-imports ratchet).',
  },
}
