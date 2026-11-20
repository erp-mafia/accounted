export default {
  rule: 'provider-document-state',
  says: 'What a provider document is outranks its amounts: an unissued invoice is a draft, a negative total a credit note, an unissued credit note stays a draft.',
  home: 'src/lib/providers/document-state.ts: documentState',
  why: 'Six mappers each ordered cancelled, draft, credit and paid themselves: the same unissued credit note read draft, credited or paid by provider, and two let a negative total through as an open invoice.',
  match: [/\binvoiceTypeCode:.*['"]381['"]/, /\b(?:flagged|negative|total)\w*\s*(?:<\s*0)?\s*\?\s*CREDIT_NOTE_TYPE_CODE/],
  sanctioned: ['lib/providers/document-state.ts', 'lib/providers/dto.ts'],
  scan: ['lib/providers/'],
}
