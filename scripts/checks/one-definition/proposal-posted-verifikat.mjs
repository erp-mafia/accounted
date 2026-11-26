export default {
  rule: 'proposal-posted-verifikat',
  says: 'Which verifikat a staged proposal posts on approval, and in what order, is read off its preview in one place: never the verifikat a rättelse or a storno replaces, one already booked, or a categorisation\'s moms rows a second time. Rows its approval builds at the click (a supplier invoice from the inbox) are asked of the server, which works them out with the approval\'s own code, never in the browser.',
  home: 'src/components/pending-operations/review-model.ts: postedVerifikat; rows built at the click: src/lib/pending-operations/approval-verifikat.ts: approvalVerifikat',
  why: 'The first card beside Godkänn took the first rows a preview carries: a rättelse showed the verifikat it replaces, and a payment matched after its sale showed the sale alone, since preview_data is jsonb and "first" is the shortest key.',
  match: [
    // data.sale_entry, preview.expected_lines, preview_data.storno: a posted verifikat read by name.
    /\b(?:data|preview|previewData|preview_data)\??\.(?:sale_entry|storno|corrected|correction|reversal|expected_lines|journal_entry_preview|journal_entries)\b/,
    // A supplier invoice's registration worked out beside the approval instead of asked of it.
    /\bsupplierInvoiceRegistrationLines\s*\(/,
  ],
  sanctioned: ['components/pending-operations/review-model.ts'],
  allowed: {
    'components/pending-operations/OperationPreview.tsx':
      'the review of a rättelse draws the verifikat it replaces beside its correction, each by name.',
  },
  // Where a staged preview is read for the person who approves it.
  scan: ['components/pending-operations/', 'app/(dashboard)/pending/'],
}
