import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { SIEJobFailedError } from '@/lib/import/sie-job-client'
import { describeSIEJobFailure, formatImportFailure } from '@/lib/import/import-failure'
import type { SIEJob } from '@/lib/import/sie-job-contract'

/**
 * The books act's SIE step, when the import job pauses or fails (crm#1653).
 * The job recorded a raw database error, and the step ran the whole failure
 * through getErrorMessage, which refuses technical text: the import
 * reference and the "Fortsätt eller ångra under Importhistorik" hint went
 * with it, leaving "Något gick fel. Försök igen.". describeSIEJobFailure now
 * says in Swedish what happened, and the step shows the job's message as is,
 * as the provider step already did.
 */

const stepSource = readFileSync(join(__dirname, '..', 'steps', 'SieStep.tsx'), 'utf8')

function pausedJobError(): SIEJobFailedError {
  const job = {
    id: 'imp-1',
    job_state: 'paused',
    error_message: 'Database operation "import_sie_chunk" failed: duplicate key value violates unique constraint "journal_import_source_owned_idx"',
    job_result: null,
  } as unknown as SIEJob
  const failure = describeSIEJobFailure(job)
  failure.message += ' Fortsätt eller ångra under Importhistorik.'
  return new SIEJobFailedError(job, failure)
}

describe('SIE step, a job that stopped (crm#1653)', () => {
  it('shows the job\'s own message for a SIEJobFailedError, not the generic fallback', () => {
    expect(stepSource).toMatch(/err instanceof SIEJobFailedError \? formatImportFailure\(err\.failure\) : getErrorMessage\(err, \{ locale \}\)/)
  })

  it('that message says what happened, where to continue and which import, in Swedish', () => {
    expect(pausedJobError().message).toBe(
      'Importen stannade på ett tekniskt fel och behöver granskas. Fortsätt eller ångra under Importhistorik.\n' +
      'Referens: import imp-1',
    )
    expect(pausedJobError().message).not.toMatch(/duplicate key|constraint/)
    expect(formatImportFailure(pausedJobError().failure)).toBe(pausedJobError().message)
  })

  it('it passes getErrorMessage unchanged too: nothing technical is left to refuse', () => {
    expect(getErrorMessage(pausedJobError(), { locale: 'sv' })).toBe(pausedJobError().message)
  })
})
