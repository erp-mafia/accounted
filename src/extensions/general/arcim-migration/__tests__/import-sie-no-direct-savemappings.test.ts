/**
 * Guard against re-adding a direct saveMappings() call to the migration
 * wizard's /import-sie handler.
 *
 * The handler used to run `await saveMappings(supabase, user.id, mappings)`
 * before submitSIEJob: user.id in the companyId slot. Once saveMappings
 * started surfacing upsert failures (and filling user_id), that call threw on
 * RLS/FK on every request, 500ing every provider-migration import before a
 * single voucher was written. The call was also redundant: submitSIEJob
 * saves the mappings itself (lib/import/sie-import.ts), with the correct
 * companyId + userId and non-fatal warning handling.
 *
 * A source-level assertion is deliberate: the handler builds its Supabase
 * client inline and the failure mode is "a future refactor re-imports the
 * helper", which this catches regardless of how the handler is wired.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const indexSource = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

describe('arcim-migration /import-sie handler', () => {
  it('does not call saveMappings directly (submitSIEJob persists mappings itself)', () => {
    expect(indexSource).not.toMatch(/\bsaveMappings\s*\(/)
    expect(indexSource).not.toMatch(/import\s*\{[^}]*\bsaveMappings\b[^}]*\}/)
  })

  it('still routes the import through submitSIEJob, which owns mapping persistence', () => {
    expect(indexSource).toContain('submitSIEJob(supabase,companyId,user.id,rawContent,mappings')
  })
})
