export default {
  rule: 'rule-track-record',
  says: "How often a counterpart rule's suggestion was booked as proposed is counted in one place, from the decision receipts: the rule's first-place suggestions on decided bank lines, and matches_final on them.",
  home: 'src/lib/rules/track-record.ts: trackRecordFrom, readRuleTrackRecord',
  why: 'The rule page and every later reader (a promotion on the ladder, an agent asking whether a rule still holds) must agree on what counts as a decision and as right; a second count would let a rule look trusted on one screen and not on another.',
  match: [
    // A rule's first suggestion read out of suggestion_log by hand.
    /suggestions->0->>source_id/,
  ],
  sanctioned: ['lib/rules/track-record.ts'],
}
