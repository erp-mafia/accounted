import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Rules ladder columns on categorization_templates (migration
 * 20260907121500). The trigger keeps `mode` and `is_active` in step in both
 * directions: the booking engine keeps reading is_active, the Regler pages
 * read mode, and neither side can drift.
 */

async function insertTemplate(companyId: string, overrides: Record<string, unknown> = {}) {
  const cols = {
    company_id: companyId,
    counterparty_name: `acme ${Math.random().toString(36).slice(2, 8)}`,
    debit_account: '6540',
    credit_account: '1930',
    ...overrides,
  }
  const keys = Object.keys(cols)
  const { rows } = await getPool().query(
    `INSERT INTO public.categorization_templates (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id, mode, is_active, paused_at, corrections`,
    keys.map((k) => cols[k as keyof typeof cols]),
  )
  return rows[0] as { id: string; mode: string; is_active: boolean; paused_at: string | null; corrections: number }
}

async function readTemplate(id: string) {
  const { rows } = await getPool().query(
    `SELECT mode, is_active, paused_at, corrections FROM public.categorization_templates WHERE id = $1`,
    [id],
  )
  return rows[0] as { mode: string; is_active: boolean; paused_at: string | null; corrections: number }
}

describe('categorization_templates rules ladder', () => {
  it('a new template proposes, with zero corrections', async () => {
    const { companyId } = await seedCompany()
    const row = await insertTemplate(companyId)
    expect(row.mode).toBe('propose')
    expect(row.is_active).toBe(true)
    expect(row.paused_at).toBeNull()
    expect(row.corrections).toBe(0)
  })

  it('soft-deleting through is_active reads as paused', async () => {
    const { companyId } = await seedCompany()
    const row = await insertTemplate(companyId)
    await getPool().query(`UPDATE public.categorization_templates SET is_active = false WHERE id = $1`, [row.id])
    const after = await readTemplate(row.id)
    expect(after.mode).toBe('paused')
    expect(after.is_active).toBe(false)
    expect(after.paused_at).not.toBeNull()
  })

  it('pausing through mode stops the engine from matching, resuming restarts it', async () => {
    const { companyId } = await seedCompany()
    const row = await insertTemplate(companyId)
    await getPool().query(`UPDATE public.categorization_templates SET mode = 'paused' WHERE id = $1`, [row.id])
    let after = await readTemplate(row.id)
    expect(after.is_active).toBe(false)
    expect(after.paused_at).not.toBeNull()

    await getPool().query(`UPDATE public.categorization_templates SET mode = 'propose' WHERE id = $1`, [row.id])
    after = await readTemplate(row.id)
    expect(after.is_active).toBe(true)
    expect(after.paused_at).toBeNull()
  })

  it('re-activating a soft-deleted template puts it back on the ladder as propose', async () => {
    const { companyId } = await seedCompany()
    const row = await insertTemplate(companyId, { is_active: false })
    expect(row.mode).toBe('paused')
    await getPool().query(`UPDATE public.categorization_templates SET is_active = true WHERE id = $1`, [row.id])
    const after = await readTemplate(row.id)
    expect(after.mode).toBe('propose')
    expect(after.paused_at).toBeNull()
  })

  it('rejects modes outside the ladder', async () => {
    const { companyId } = await seedCompany()
    await expect(insertTemplate(companyId, { mode: 'manual' })).rejects.toThrow(/categorization_templates_mode_check/)
  })
})
