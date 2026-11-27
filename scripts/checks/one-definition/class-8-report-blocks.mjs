export default {
  rule: 'class-8-report-blocks',
  says: 'The resultaträkning and the resultatrapport split class 8 as the uppställningsform does: finansiella poster (80-84, and any other kontogrupp but 88 and 89), then Resultat efter finansiella poster, then bokslutsdispositioner (88) and skatter (89).',
  home: 'src/lib/reports/class-8-groups.ts: class8GroupOf',
  why: "The resultaträkning PDF split class 8 by a prefix list of its own, while the resultaträkning's page and Excel put 88 and 89 under Finansiella poster and the resultatrapport showed class 8 as one group.",
  match: [
    // The finansiella poster as a hand-written list of kontogrupper, in any quotes.
    /\[\s*(['"`])80\1\s*,\s*\1(?:81)\1\s*,\s*\1(?:82)\1\s*,\s*\1(?:83)\1\s*,\s*\1(?:84)\1\s*\]/,
    // A block's sum line written by hand.
    /['"`]Summa (?:bokslutsdispositioner|skatter)['"`]/,
  ],
  sanctioned: ['lib/reports/class-8-groups.ts'],
  allowed: {
    'lib/bokslut/ixbrl/document/statements.ts':
      "the årsredovisning's resultaträkning: its lines are the K2 taxonomy's items from the K2 mapper, not kontogrupper.",
  },
}
