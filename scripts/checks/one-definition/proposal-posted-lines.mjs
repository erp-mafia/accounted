export default {
  rule: 'proposal-posted-lines',
  says: 'The verifikat rows approving a proposal posts are read off its staged preview in one place: a rättelse or a storno carries the verifikat it replaces beside the one it posts, and only the one it posts counts.',
  home: 'src/components/pending-operations/review-model.ts: postedLines',
  why: 'The first rows a rättelse stages are the verifikat it replaces: the headline amount knew to skip them, and a second reader of the rows (the card beside Godkänn) would have shown them as booked.',
  match: [
    // [x.correction, x.reversal] or x.reversal ?? x.correction: the posted verifikat picked by hand.
    /\.correction\b[^\n]*\.reversal\b/,
    /\.reversal\b[^\n]*\.correction\b/,
  ],
  sanctioned: ['components/pending-operations/review-model.ts'],
  scan: ['app/', 'components/'],
}
