import { describe, expect, it, vi } from 'vitest'
import { evaluateCommitGates } from '@/lib/bookkeeping/commit-gates'

function mockSupabase(entry: {
  entry_date: string
  description?: string
  accounts?: string[]
}) {
  return {
    from(table: string) {
      if (table === 'journal_entries') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'e1',
                    company_id: 'c1',
                    entry_date: entry.entry_date,
                    description: entry.description ?? 'Test',
                    status: 'draft',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'journal_lines') {
        return {
          select: () => ({
            eq: async () => ({
              data: (entry.accounts ?? ['4010']).map((account_number) => ({
                account_number,
              })),
              error: null,
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

describe('evaluateCommitGates', () => {
  it('blocks late cash on any ledger mode', async () => {
    vi.stubEnv('OMBRA_LEDGER_MODE', 'local')
    const gates = await evaluateCommitGates(
      mockSupabase({
        entry_date: '2026-07-14',
        description: 'Kontantförsäljning',
        accounts: ['1910', '3010'],
      }) as never,
      'c1',
      'e1',
      { today: '2026-07-17' },
    )
    expect(gates.ok).toBe(false)
    expect(gates.blocked[0]?.code).toBe('CASH_LATE')
    vi.unstubAllEnvs()
  })

  it('blocks 50-day late only on hosted', async () => {
    vi.stubEnv('OMBRA_LEDGER_MODE', 'hosted')
    const hosted = await evaluateCommitGates(
      mockSupabase({ entry_date: '2026-01-01', description: 'Faktura' }) as never,
      'c1',
      'e1',
      { today: '2026-03-01', ledgerMode: 'hosted' },
    )
    expect(hosted.ok).toBe(false)

    const local = await evaluateCommitGates(
      mockSupabase({ entry_date: '2026-01-01', description: 'Faktura' }) as never,
      'c1',
      'e1',
      { today: '2026-03-01', ledgerMode: 'local' },
    )
    expect(local.ok).toBe(true)
    expect(local.warnings.length).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })
})
