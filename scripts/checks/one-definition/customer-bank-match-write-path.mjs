export default {
  rule: 'customer-bank-match-write-path',
  says: 'Matching one bank row to one customer invoice runs one write sequence, whatever the door.',
  home: 'src/lib/invoices/book-customer-bank-match.ts: bookCustomerBankMatch',
  why: 'Three copies drifted: only the dashboard knew an active credit note, only the approval wrote no match log and no invoice PDF, and each treated a booked row its own way, so one 1500 kr row moved 1930 by 3000 kr.',
  match: [/type:\s*'invoice\.match_confirmed'/],
  sanctioned: ['lib/invoices/book-customer-bank-match.ts'],
  allowed: {
    'lib/events/types.ts': 'the event declared: nothing is booked.',
    'lib/transactions/batch-allocation-events.ts': 'one bank row over several invoices: match_batch_allocate books them in one verifikat and the batch emits per allocation.',
    'lib/transactions/link-journal-entry.ts': 'a link to a verifikat that exists: nothing posts, so there is no payment verifikat to claim or unwind.',
  },
}
