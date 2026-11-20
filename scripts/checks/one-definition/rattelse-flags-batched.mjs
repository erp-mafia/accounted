export default {
  rule: 'rattelse-flags-batched',
  says: 'A corrected voucher shows it at any list size: the rattelse flags are read in batches at the route limit.',
  home: 'src/lib/bookkeeping/rattelse-flags.ts: fetchRattelseFlags',
  why: 'The list sent every loaded voucher in one request, so Visa alla got a 400 past 200 vouchers and every Rättad marker vanished without a word.',
  match: [/journal-entries\/rattelse-flags\?/],
  sanctioned: ['lib/bookkeeping/rattelse-flags.ts'],
}
