export default {
  rule: 'retag-lock-check',
  says: 'A posted line behind a period lock (a closed or locked period, the company lock date) is never retagged, and a retag door asks that in one place before the write, in its preview and its commit alike.',
  home: 'src/lib/dimensions/retag-lock.ts: retagBlockOf',
  why: 'A bulk retag preview counted every matched line while the approval left the lines of a closed year untagged and answered a plain committed (crm#1908).',
  match: [
    // supabase.rpc('retag_line_dimensions', ...): a door that writes tags past
    // retagLines, so past the lock check and the outcome it answers.
    /\.rpc\(\s*['"]retag_line_dimensions['"]/,
  ],
  sanctioned: ['lib/dimensions/retag-service.ts'],
  allowed: {
    'app/api/bookkeeping/journal-entry-lines/[lineId]/retag/route.ts':
      "One line from the verifikat page: nothing is previewed or counted, and the RPC's own refusal is the answer shown.",
  },
}
