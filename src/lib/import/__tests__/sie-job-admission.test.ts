import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { userFacingCode } from '@/lib/errors/user-facing'
import { acceptsSIEJobs, SIEJobValidationError, submitSIEJob } from '../sie-jobs'
import type { AccountMapping } from '../types'

// Admission of new SIE imports (SIE_IMPORT_JOBS). Hosted keeps the cutover
// contract: off unless switched on. A self-hosted install has no cutover to
// stage and ships the worker cron, so there it is on unless switched off.

const options = { filename: 'ledger.se', createFiscalPeriod: false, importOpeningBalances: false, importTransactions: true }
const mappings: AccountMapping[] = ['1930', '3001'].map((number) => ({
  sourceAccount: number, targetAccount: number, sourceName: 'Account', targetName: 'Account',
  confidence: 1, matchType: 'exact', isOverride: false,
}))
const content =
  '#FLAGGA 0\n#SIETYP 4\n#RAR 0 20260101 20261231\n#VER "" "" 20260201 "Synthetic"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'

const HOSTED_SENTENCE = 'Nya SIE-importer är tillfälligt pausade. Pågående importer fortsätter.'

/** A database that must never be reached: a refusal happens before any read. */
function untouchedDatabase() {
  return { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }
}

function submit(database: ReturnType<typeof untouchedDatabase>, withMappings = mappings) {
  return submitSIEJob(database as unknown as SupabaseClient, 'company-1', 'user-1', content, withMappings, options)
}

function deployment(selfHosted: boolean, flag: string | undefined) {
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', selfHosted ? 'true' : undefined)
  vi.stubEnv('SIE_IMPORT_JOBS', flag)
}

describe('SIE import admission', () => {
  afterEach(() => vi.unstubAllEnvs())

  describe('hosted (unchanged)', () => {
    it.each<[string | undefined, boolean]>([
      [undefined, false],
      ['', false],
      ['false', false],
      ['true', true],
    ])('SIE_IMPORT_JOBS=%s admits: %s', (flag, admitted) => {
      deployment(false, flag)
      expect(acceptsSIEJobs()).toBe(admitted)
    })

    it('refuses with the same sentence as before, naming no setting, before any database read', async () => {
      deployment(false, undefined)
      const database = untouchedDatabase()

      const error = await submit(database).catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(SIEJobValidationError)
      expect((error as Error).message).toBe(HOSTED_SENTENCE)
      expect(database.from).not.toHaveBeenCalled()
      expect(database.rpc).not.toHaveBeenCalled()
      expect(database.storage.from).not.toHaveBeenCalled()
    })
  })

  describe('self-hosted', () => {
    it.each<[string | undefined, boolean]>([
      // Nothing set: the state of every install whose .env predates the flag.
      [undefined, true],
      // An empty assignment in .env is not a decision to switch it off.
      ['', true],
      ['true', true],
      ['false', false],
    ])('SIE_IMPORT_JOBS=%s admits: %s', (flag, admitted) => {
      deployment(true, flag)
      expect(acceptsSIEJobs()).toBe(admitted)
    })

    it('admits an import with nothing configured: the submission gets past the gate', async () => {
      deployment(true, undefined)
      const database = untouchedDatabase()

      // A refusal that only the validation AFTER the admission gate raises
      // (a class 9 target for an account with amounts) proves the gate let
      // the submission through, without faking the whole job protocol.
      await expect(submit(database, [mappings[0], { ...mappings[1], targetAccount: '9999' }])).rejects.toMatchObject({
        code: 'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS',
      })
    })

    it('tells the operator which setting switched it off, as a user-facing sentence', async () => {
      deployment(true, 'false')
      const database = untouchedDatabase()

      const error = await submit(database).catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(SIEJobValidationError)
      const message = (error as Error).message
      expect(message).not.toBe(HOSTED_SENTENCE)
      expect(message).toContain('SIE_IMPORT_JOBS=false')
      expect(message).toContain('SIE_IMPORT_JOBS=true')
      expect(message).toContain('Pågående importer fortsätter.')
      // The sentence reaches the wizard as written (400 VALIDATION_ERROR),
      // not as the registry's generic line.
      expect(userFacingCode(error)).toBe('VALIDATION_ERROR')
      expect(database.from).not.toHaveBeenCalled()
      expect(database.rpc).not.toHaveBeenCalled()
    })
  })
})
