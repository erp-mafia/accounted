export default {
  rule: 'equity-movement-row-label',
  says: 'The row label of a kind of movement in the specification of changes in equity comes from equityMovementLabel, which knows what the year\'s regelverk calls the row: the K2 taxonomy\'s own rubrik for a K2 year.',
  home: 'src/lib/bokslut/arsredovisning/equity-kinds.ts: equityMovementLabel',
  why: 'The iXBRL adapter kept a table of the labels of its own, without the two insats kinds (their rows printed the kind\'s key), and a second table would not have followed the PDF when a K2 year got the K2 taxonomy\'s rubriker.',
  match: [
    // aterbetalt_tillskott: 'Återbetalda tillskott': a kind mapped to a phrase.
    // A kind mapped to a concept name (one word) is not a label.
    /\b(?:rattelse_av_fel|andrad_redovisningsprincip|aktieagartillskott|aterbetalt_tillskott|insatser_inbetalda|insatser_aterbetalda|andra_vardeoverforingar|ovriga_direkt_mot_eget_kapital):\s*['"`][^'"`]* [^'"`]*['"`]/,
  ],
  sanctioned: ['lib/bokslut/arsredovisning/equity-kinds.ts'],
}
