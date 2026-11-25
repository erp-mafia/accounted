export default {
  rule: 'accumulated-contra-account',
  says: 'The accumulated av- och nedskrivningar of immateriella and materiella anläggningstillgångar are BAS 10x8/10x9 to 12x8/12x9, never the förskott and pågående nyanläggningar of 108x, 118x and 128x.',
  home: 'src/lib/bookkeeping/bas-data/accumulated-contra-accounts.ts: isAccumulatedContraAccount',
  why: 'The cash flow statement held the pattern twice, and the first draft of a third copy, for the asset note, read 1088, 1188 and 1288 (förskott) as accumulated avskrivningar.',
  match: [
    // /^1[012][0-79][89]$/ or /^1[0-2]\d[89]$/: the contra pattern written again.
    /1\[0(?:12|-2)\](?:\[0-79\]|\\d)\[89\]/,
  ],
  sanctioned: ['lib/bookkeeping/bas-data/accumulated-contra-accounts.ts'],
}
