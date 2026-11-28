export default {
  rule: 'reverse-charge-basis-counted-twice',
  says: 'Typed lines count a reverse-charge purchase twice in rutor 20-24 when a 45xx/4598 basis pair sits beside an account that reports ruta 20-24 itself and the basis they report exceeds both what their fiktiv moms is computed on and the pair.',
  home: 'src/lib/reports/rc-basis-gaps.ts: rcBasisCountedTwice',
  why: 'A rättelse could put a basis pair beside a cost account with its own reverse-charge momskod, declaring the purchase twice, and only the producers avoided that shape while no door that takes typed lines said so.',
  match: [
    // The reported basis held against the fiktiv moms basis by hand, the
    // over-reporting side (isRcBasisGap is the short side).
    /reportedBasisAmount\b[^;]*>\s*[\w.]*expectedBasisAmount/,
    /expectedBasisAmount\b[^;]*<\s*[\w.]*reportedBasisAmount/,
  ],
  sanctioned: ['lib/reports/rc-basis-gaps.ts'],
}
