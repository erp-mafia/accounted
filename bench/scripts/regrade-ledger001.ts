// One-time re-grade for the ledger-001 assertion remediation (2026-08-31):
// 'exactly one voucher' was over-specified. The invoice-then-payment split
// through 2440 is correct practice, and the four balance assertions force
// every other account to net zero, so the correct check is 'at most two
// vouchers'. Stored records carry the full assertion results, so past runs
// are re-graded without re-running agents; applies to every model equally.
//
//   npx tsx bench/scripts/regrade-ledger001.ts

import fs from 'node:fs'
import path from 'node:path'
import { BENCH_ROOT } from '../src/util'
import type { RunRecord } from '../src/types'

interface StoredAssertion {
  name: string
  pass: boolean
  detail: string
}

const dir = path.join(BENCH_ROOT, 'results', 'runs')
let flipped = 0
for (const file of fs.readdirSync(dir)) {
  if (!file.includes('-ledger-agent-') || !file.endsWith('.jsonl')) continue
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)
  const out: string[] = []
  for (const line of lines) {
    const rec = JSON.parse(line) as RunRecord
    const assertions = rec.score.assertions as StoredAssertion[] | undefined
    if (rec.taskId !== 'ledger-001' || !assertions) {
      out.push(line)
      continue
    }
    const updated = assertions.map((a) => {
      if (a.name !== 'exactly one voucher') return a
      const got = Number(/got (\d+)/.exec(a.detail)?.[1] ?? 'NaN')
      return {
        name: 'at most two vouchers (invoice, optionally separate payment)',
        pass: got >= 1 && got <= 2,
        detail: `got ${got}`,
      }
    })
    const pass = updated.every((a) => a.pass)
    if (pass !== rec.pass) {
      flipped++
      console.log(`${file} attempt ${rec.attempt ?? 0} ${rec.model}: ${rec.pass} -> ${pass}`)
    }
    rec.score.assertions = updated
    rec.pass = pass
    out.push(JSON.stringify(rec))
  }
  fs.writeFileSync(path.join(dir, file), out.join('\n') + '\n')
}
console.log(`Re-graded ledger-001; ${flipped} verdict(s) changed.`)
