export default {
  rule: 'underlag-propagation-on-booking',
  says: "When a person or agent books or links a bank row, the row's pinned document and matched inbox items land on that verifikat through one step.",
  home: 'src/lib/transactions/inbox-underlag.ts: propagateUnderlagForBookedTransaction',
  why: 'The customer match never ran the step and the supplier match kept a copy that skipped matched items and their stamp, so a verifikat lost underlag the row carried (BFL 5 kap 6-7 §). The bulk-book RPC anchors in SQL and the step runs after it.',
  match: [
    // Anchors a bank row's pin by hand: the evidence a copy has to name. A door
    // that forgets the step altogether writes no line this can see.
    /rule_id: 'bank_row_document_pin'/,
  ],
  sanctioned: ['lib/transactions/inbox-underlag.ts'],
  allowed: {
    'app/api/v1/companies/[companyId]/journal-entries/[id]/route.ts': 'an example in the API docs: nothing is written.',
    'lib/transactions/document-attach.ts': 'a person attaches a document to a row already booked: their own word (user_confirmed), and the step then runs for the rest.',
  },
}
