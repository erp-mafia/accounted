// The SQL repeats this rule: public.verifikat_display_amounts (supabase/migrations/
// 20261125130100_verifikat_list_amount_sort_set_based.sql) gives the list RPCs that sort by
// Belopp (list_verifikat_by_amount, list_verifikat_missing_underlag) the amount of every
// verifikat in scope in one statement, where a TypeScript function cannot reach, and this
// guard does not scan SQL. That copy is acceptable because it is the only other one
// (20261125143100 dropped the per-row display_amount column), both name each other, and
// tests/pg/verifikat-list-amount-sort.pg.test.ts pins it on the shapes in
// src/lib/bookkeeping/__tests__/voucher-display-amount.shapes.ts that this home's unit test
// pins.
export default {
  rule: 'verifikat-shown-amount',
  says: "The Belopp a verifikat shows, and the amount the verifikat list sorts by, is the absolute net of its one line on a money account (BAS 19xx, or a ledger the company keeps a cash account on), unless that net is zero, another asset line sits on the money line's side or the verifikat is an opening balance; otherwise the omslutning.",
  home: 'src/lib/bookkeeping/voucher-display-amount.ts: voucherDisplayAmount (SQL: public.verifikat_display_amounts)',
  why: 'The amount sort ordered by the omslutning while the column showed the money line, and later the rule had two SQL bodies, a per-row column and a set function, that one change could split.',
  match: [
    // A list sorted by a per-row amount column instead of a list RPC that
    // reads verifikat_display_amounts: the omslutning (a number the Belopp
    // column does not show) or the dropped display_amount.
    /\.order\(\s*['"`](?:total_amount|display_amount)['"`]/,
  ],
  sanctioned: ['lib/bookkeeping/voucher-display-amount.ts'],
}
