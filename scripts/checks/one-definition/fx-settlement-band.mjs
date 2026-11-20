export default {
  rule: 'fx-settlement-band',
  says: 'How far a SEK payment may sit from a foreign remainder and still settle it is read one way: inside the band it settles, short of it it is a part payment, above what the remainder can explain it is refused.',
  home: 'src/lib/bookkeeping/fx-settlement.ts: fxSettlementOutcome, fxDeviationTooLarge (public.fx_deviation_too_large)',
  why: 'The customer match read 2 %, the batch and the link 10 %, and the supplier match nothing at all, so half a payment closed a debt and booked the rest as gain.',
  match: [
    // converted against remaining, by hand.
    /Math\.abs\(\w*[cC]onverted\w*\s*-\s*\w*[rR]emaining\w*\)/,
    // The limit as a literal against a booked or expected SEK figure.
    /\*\s*0\.1\b.*\b(?:booked|expected)\w*|\b(?:booked|expected)\w*\s*\*\s*0\.1\b/i,
  ],
  sanctioned: ['lib/bookkeeping/fx-settlement.ts'],
}
