import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { MAX_BANK_ROW_SPLIT } from '@/lib/reconciliation/limits'

/**
 * Every route that commits a batch match must outlast a full batch. After the
 * RPC, lib/transactions/batch-allocation-events.ts reads each invoice and
 * emits its events one by one: about 70 ms per invoice in production (19
 * invoices took 1.26 s, crm#1297). Twice that per invoice leaves room for the
 * guards, the RPC and a slow minute. Without the export a route runs on the
 * platform default of 60 s.
 */
const EVENT_MS_PER_INVOICE = 70
const PLATFORM_DEFAULT_S = 60

const COMMIT_ROUTES = [
  'src/app/api/transactions/[id]/match-batch/route.ts',
  'src/app/api/v1/companies/[companyId]/transactions/[id]/match-batch/route.ts',
  'src/app/api/pending-operations/[id]/commit/route.ts',
  'src/app/api/pending-operations/bulk-commit/route.ts',
  'src/app/api/v1/companies/[companyId]/pending-operations/[id]/approve/route.ts',
]

/** Next.js reads segment config as a literal, so the source carries the value. */
function maxDurationOf(path: string): number {
  const match = readFileSync(join(process.cwd(), path), 'utf8').match(/^export const maxDuration = (\d+)$/m)
  return match ? Number(match[1]) : PLATFORM_DEFAULT_S
}

describe('function budget for a full batch match (crm#1297)', () => {
  it.each(COMMIT_ROUTES)('%s outlasts the events of MAX_BANK_ROW_SPLIT invoices', (path) => {
    expect(maxDurationOf(path) * 1000).toBeGreaterThanOrEqual(2 * MAX_BANK_ROW_SPLIT * EVENT_MS_PER_INVOICE)
  })
})
