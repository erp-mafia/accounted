export default {
  rule: 'ore-settlement-band',
  says: 'Öresavrundning is for pure SEK settlements, for a gap strictly under one krona, booked on 3740.',
  home: 'src/lib/bookkeeping/ore-rounding.ts: oreSettlementResidual (public.ore_settlement_residual)',
  why: 'Six past fixes each reached the copies their author touched, and the SQL door kept six literals that also booked 3740 on a foreign row.',
  match: [
    /Math\.abs\([^)]*\)\)?\s*<\s*ORE_ROUNDING_SETTLEMENT_MAX/,
    /Math\.abs\(\w*[oO]re\w*\)\s*<\s*1(?:\.0+)?\b/,
  ],
  sanctioned: ['lib/bookkeeping/ore-rounding.ts'],
}
