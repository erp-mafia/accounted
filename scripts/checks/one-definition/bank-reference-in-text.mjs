export default {
  rule: 'bank-reference-in-text',
  says: 'A reference names a document only as a whole number in the text, compared on its digits; an empty needle answers no.',
  home: 'src/lib/invariants/reference-number.ts: descriptionMentionsReference, normalizeOcrReference',
  why: 'A substring test read reference 1234 in 212345 and a bankgiro inside an OCR number, at the scores that apply a match unattended, and a giro with no digits matched every text.',
  match: [
    /\.includes\((normalizeOcrReference|normalizeReference|txReference)\b/,
  ],
  allowed: {
    'lib/invoices/invoice-matching.ts': 'set membership of a key, not a text test.',
  },
}
