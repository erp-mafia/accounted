// Regenerate bench/tasks/booking/context-accounts.txt from the repo's BAS
// 2026 reference data. The committed file is the fixed environment every
// model sees; regenerate only when the BAS data changes, and commit the diff.
//
//   npx tsx bench/scripts/build-booking-context.ts

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLASS_1_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-1-assets'
import { CLASS_2_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-2-equity-liabilities'
import { CLASS_3_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-3-revenue'
import { CLASS_4_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-4-purchases'
import { CLASS_5_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-5-external-expenses'
import { CLASS_6_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-6-other-external'
import { CLASS_7_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-7-personnel'
import { CLASS_8_ACCOUNTS } from '../../lib/bookkeeping/bas-data/class-8-financial'

const all = [
  ...CLASS_1_ACCOUNTS,
  ...CLASS_2_ACCOUNTS,
  ...CLASS_3_ACCOUNTS,
  ...CLASS_4_ACCOUNTS,
  ...CLASS_5_ACCOUNTS,
  ...CLASS_6_ACCOUNTS,
  ...CLASS_7_ACCOUNTS,
  ...CLASS_8_ACCOUNTS,
].sort((a, b) => a.account_number.localeCompare(b.account_number))

const lines = all.map((a) => `${a.account_number} ${a.account_name}`)
const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tasks',
  'booking',
)
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'context-accounts.txt'), lines.join('\n') + '\n')
console.log(`Wrote ${lines.length} accounts to tasks/booking/context-accounts.txt`)
