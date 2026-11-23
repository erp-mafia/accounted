export default {
  rule: 'bank-candidate-lines-read',
  says: "A bank reconciliation candidate list is read as its RPC's narrowing once and its predicate on slices of the verifikat the narrowing names, never as .range() pages of get_unlinked_gl_lines or get_account_gl_lines_for_matching.",
  home: 'src/lib/reconciliation/bank-reconciliation.ts: fetchUnlinkedGLLines, fetchGLLinesForMatching (readCandidateLines)',
  why: 'The RPCs are plpgsql, so PostgREST ran the whole window again for every 1 000-row page: one run on the largest account took longer than the 8 s statement timeout, and a bank run without date_from failed on its first page (crm#2150).',
  match: [
    // The whole-window RPCs called from the app.
    /['"`]get_unlinked_gl_lines['"`]/,
    /['"`]get_account_gl_lines_for_matching['"`]/,
  ],
}
