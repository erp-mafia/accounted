export default {
  rule: 'salary-run-calculated-state',
  says: 'A write that changes an input the engine reads leaves the run stale, so approval and booking refuse figures the engine did not produce for the current inputs.',
  home: 'src/lib/salary/invalidate-calculation.ts: invalidateRunCalculation',
  why: 'A bonus added after the calculation left the run current: 7210 stayed at 40 000 while the printed 10 000 went unpaid, because only two doors cleared the proof.',
  match: [/calculation_breakdown:\s*null/],
  sanctioned: ['lib/salary/invalidate-calculation.ts'],
  allowed: {
    'app/(dashboard)/salary/runs/[id]/page.tsx': 'Mirrors the server clear in client state until the reload, writes nothing.',
  },
}
