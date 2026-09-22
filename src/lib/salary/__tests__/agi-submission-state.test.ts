import { describe, expect, it } from 'vitest'
import {
  deriveAgiFilingState,
  resolveRunAgiKvittensnummer,
  resolveRunAgiSubmission,
  type AgiFilingRun,
  type AgiSubmissionState,
} from '../agi-submission-state'

describe('deriveAgiFilingState', () => {
  const bare = { agi_generated_at: null, agi_submitted_at: null }
  const generated = { agi_generated_at: '2026-07-13T09:48:58Z', agi_submitted_at: null }

  it('returns none when nothing has happened', () => {
    expect(deriveAgiFilingState(bare, null)).toBe('none')
    expect(deriveAgiFilingState(bare, undefined)).toBe('none')
    expect(deriveAgiFilingState(bare, {})).toBe('none')
  })

  it('returns generated when only the XML exists', () => {
    expect(deriveAgiFilingState(generated, null)).toBe('generated')
  })

  it('follows the submission record through the filing steps', () => {
    expect(deriveAgiFilingState(generated, { status: 'underlag_submitted' })).toBe(
      'underlag_submitted',
    )
    expect(deriveAgiFilingState(generated, { status: 'awaiting_signing' })).toBe(
      'awaiting_signing',
    )
    expect(deriveAgiFilingState(generated, { status: 'signed' })).toBe('signed')
  })

  it('treats a rejected underlag as back-to-generated', () => {
    expect(deriveAgiFilingState(generated, { status: 'underlag_rejected' })).toBe('generated')
  })

  it('a rejected underlag with no generated XML falls back to none', () => {
    expect(deriveAgiFilingState(bare, { status: 'underlag_rejected' })).toBe('none')
  })

  it('run.agi_submitted_at is authoritative over a stale submission record', () => {
    const filed = { agi_generated_at: '2026-07-13T09:48:58Z', agi_submitted_at: '2026-07-13T10:02:11Z' }
    expect(deriveAgiFilingState(filed, null)).toBe('signed')
    expect(deriveAgiFilingState(filed, { status: 'awaiting_signing' })).toBe('signed')
    expect(deriveAgiFilingState(filed, { status: 'underlag_submitted' })).toBe('signed')
  })

  it('a signed submission record counts even before the run row is stamped', () => {
    expect(deriveAgiFilingState(generated, { status: 'signed', kvittensnummer: 'abc-123' })).toBe(
      'signed',
    )
  })
})

/**
 * Correcting a filed arbetsgivardeklaration means resubmitting a complete AGI
 * for the same redovisningsperiod (same specifikationsnummer per employee).
 * The correction is its own submission and gets its own kvittens, so the two
 * runs sharing the period must never share filing state or receipt.
 *
 * Timeline used throughout:
 *   T0 original generates XML     T1 original signs (kvittens K1)
 *   T2 correction generates XML   T3 correction signs (kvittens K2)
 */
describe('correction run in the same period as a filed run', () => {
  const T0 = '2026-07-13T09:00:00Z'
  const T1 = '2026-07-13T10:00:00Z'
  const T2 = '2026-07-20T11:00:00Z'
  const T3 = '2026-07-20T12:00:00Z'

  const ORIGINAL_ID = '11111111-1111-4111-8111-111111111111'
  const CORRECTION_ID = '22222222-2222-4222-8222-222222222222'

  /** What the extension leaves behind after the original was signed. */
  const originalSigned = {
    status: 'signed' as const,
    kvittensnummer: 'K1',
    signeradTid: T1,
    updatedAt: T1,
  }

  const originalFiled = {
    id: ORIGINAL_ID,
    agi_generated_at: T0,
    agi_submitted_at: T1,
  }

  it('the original run shows done with its own kvittens', () => {
    expect(deriveAgiFilingState(originalFiled, originalSigned)).toBe('signed')
    expect(resolveRunAgiKvittensnummer(originalFiled, originalSigned)).toBe('K1')
  })

  it('a correction run opened afterwards is NOT done and shows no kvittens', () => {
    // Fresh correction run: /correct inserts it with both agi_* timestamps null.
    const correction = {
      id: CORRECTION_ID,
      agi_generated_at: null,
      agi_submitted_at: null,
    }
    expect(deriveAgiFilingState(correction, originalSigned)).toBe('none')
    expect(resolveRunAgiKvittensnummer(correction, originalSigned)).toBeNull()
    expect(resolveRunAgiSubmission(correction, originalSigned)).toBeNull()
  })

  it('a correction run that regenerated its XML sits at generated, not signed', () => {
    const correction = {
      id: CORRECTION_ID,
      agi_generated_at: T2,
      agi_submitted_at: null,
    }
    expect(deriveAgiFilingState(correction, originalSigned)).toBe('generated')
    expect(resolveRunAgiKvittensnummer(correction, originalSigned)).toBeNull()
  })

  it('the correction run advances on its own underlag, matched by salaryRunId', () => {
    const correction = {
      id: CORRECTION_ID,
      agi_generated_at: T2,
      agi_submitted_at: null,
    }
    const underlag = {
      status: 'underlag_submitted' as const,
      salaryRunId: CORRECTION_ID,
      inlamningId: 4711,
      updatedAt: T2,
    }
    expect(deriveAgiFilingState(correction, underlag)).toBe('underlag_submitted')
    // The original must not pick the correction's in-flight underlag up: it
    // stays 'signed' off its own stamp, never 'underlag_submitted'.
    expect(deriveAgiFilingState(originalFiled, underlag)).toBe('signed')
    expect(resolveRunAgiSubmission(originalFiled, underlag)).toBeNull()
  })

  it('an underlag posted by the original does not advance the correction run', () => {
    const correction = {
      id: CORRECTION_ID,
      agi_generated_at: T2,
      agi_submitted_at: null,
    }
    const underlag = {
      status: 'underlag_submitted' as const,
      salaryRunId: ORIGINAL_ID,
      inlamningId: 4711,
      updatedAt: T0,
    }
    expect(deriveAgiFilingState(correction, underlag)).toBe('generated')
  })

  it('the awaiting_signing record from the original does not reach the correction', () => {
    // skapaGranskningsunderlag drops salaryRunId, so age is the discriminator.
    const awaiting = {
      status: 'awaiting_signing' as const,
      signeringslank: 'https://sso.skatteverket.se/…',
      updatedAt: T1,
    }
    const correction = { id: CORRECTION_ID, agi_generated_at: T2, agi_submitted_at: null }
    expect(deriveAgiFilingState(correction, awaiting)).toBe('generated')

    // Its own granskningsunderlag, written after its XML, does reach it.
    const ownAwaiting = { ...awaiting, updatedAt: T2 }
    expect(deriveAgiFilingState(correction, ownAwaiting)).toBe('awaiting_signing')
  })

  it('the correction run filed shows its own kvittens', () => {
    const correctionFiled = {
      id: CORRECTION_ID,
      agi_generated_at: T2,
      agi_submitted_at: T3,
    }
    const correctionSigned = {
      status: 'signed' as const,
      kvittensnummer: 'K2',
      signeradTid: T3,
      updatedAt: T3,
    }
    expect(deriveAgiFilingState(correctionFiled, correctionSigned)).toBe('signed')
    expect(resolveRunAgiKvittensnummer(correctionFiled, correctionSigned)).toBe('K2')
  })

  it('two runs in the same month never share a kvittensnummer', () => {
    const correctionFiled = {
      id: CORRECTION_ID,
      agi_generated_at: T2,
      agi_submitted_at: T3,
    }
    const correctionSigned = {
      status: 'signed' as const,
      kvittensnummer: 'K2',
      signeradTid: T3,
      updatedAt: T3,
    }

    // The cache now holds the correction's receipt. Both runs read the same
    // record; only the correction may claim K2.
    expect(resolveRunAgiKvittensnummer(correctionFiled, correctionSigned)).toBe('K2')
    expect(resolveRunAgiKvittensnummer(originalFiled, correctionSigned)).toBeNull()
    // The original is still a filed declaration, just without a cached receipt.
    expect(deriveAgiFilingState(originalFiled, correctionSigned)).toBe('signed')

    // And symmetrically for the earlier cache contents.
    expect(resolveRunAgiKvittensnummer(originalFiled, originalSigned)).toBe('K1')
    expect(resolveRunAgiKvittensnummer(correctionFiled, originalSigned)).toBeNull()
  })

  it('tolerates the timestamptz round-trip format from PostgREST', () => {
    // salary_runs.agi_submitted_at comes back as +00:00, the extension writes
    // signeradTid as the Z form. Same instant, different spelling.
    const filed = {
      id: ORIGINAL_ID,
      agi_generated_at: '2026-07-13T09:00:00+00:00',
      agi_submitted_at: '2026-07-13T10:00:00+00:00',
    }
    expect(resolveRunAgiKvittensnummer(filed, originalSigned)).toBe('K1')
  })
})

describe('resolveRunAgiSubmission', () => {
  it('ignores an empty or absent record', () => {
    const run = { id: 'r1', agi_generated_at: '2026-07-13T09:00:00Z', agi_submitted_at: null }
    expect(resolveRunAgiSubmission(run, null)).toBeNull()
    expect(resolveRunAgiSubmission(run, undefined)).toBeNull()
    expect(resolveRunAgiSubmission(run, {})).toBeNull()
  })

  it('requires an id on the run to honour a salaryRunId match', () => {
    // Callers that pass a partial run (no id) must not accidentally match.
    const run = { agi_generated_at: '2026-07-13T09:00:00Z', agi_submitted_at: null }
    const record = { status: 'underlag_submitted' as const, salaryRunId: 'r1' }
    expect(resolveRunAgiSubmission(run, record)).toBeNull()
  })

  it('keeps a record with no updatedAt when the run has generated its XML', () => {
    // Older cache entries predate the updatedAt field; age is then unknown and
    // must not be treated as disqualifying.
    const run = { id: 'r1', agi_generated_at: '2026-07-13T09:00:00Z', agi_submitted_at: null }
    const record = { status: 'awaiting_signing' as const }
    expect(resolveRunAgiSubmission(run, record)).toBe(record)
  })

  it('accepts a signed record with no signeradTid on a filed run', () => {
    // Skatteverket may omit signeradTid; the reconciler then stamps the run
    // with its own clock, so the two timestamps cannot be compared.
    const run = { id: 'r1', agi_generated_at: '2026-07-13T09:00:00Z', agi_submitted_at: '2026-07-13T10:00:00Z' }
    const record = { status: 'signed' as const, kvittensnummer: 'K1', updatedAt: '2026-07-13T10:00:05Z' }
    expect(resolveRunAgiKvittensnummer(run, record)).toBe('K1')
  })

  it('ignores an unparseable timestamp rather than dropping the record', () => {
    const run = { id: 'r1', agi_generated_at: 'not-a-date', agi_submitted_at: null }
    const record = { status: 'awaiting_signing' as const, updatedAt: '2026-07-13T10:00:00Z' }
    // agi_generated_at is unusable, so the run has no provable XML of its own.
    expect(resolveRunAgiSubmission(run, record)).toBeNull()
  })
})

/**
 * Once the kvittens reconciliation (cron / post-connect refresh) has promoted
 * the declaration it deletes the period cache, and GET /agi/status serves the
 * receipt from agi_declarations instead (#1597). That record carries no
 * salaryRunId (the period's single row is repointed at a correction run when
 * one regenerates its XML), so ownership rests on the timestamps below.
 */
describe('resolveRunAgiSubmission: receipt served from agi_declarations', () => {
  const filedRun: AgiFilingRun = {
    id: 'r1',
    agi_generated_at: '2026-07-13T09:00:00Z',
    agi_submitted_at: '2026-07-14T08:30:00+00:00',
  }

  it('the run whose stamp matches signeradTid owns the receipt with its metadata', () => {
    const record: AgiSubmissionState = {
      status: 'signed',
      kvittensnummer: 'K1',
      signeradAv: '191212121212',
      signeradTid: '2026-07-14T08:30:00Z',
      submittedAt: '2026-07-14T08:30:00+00:00',
      submittedAtEstimated: false,
      updatedAt: '2026-07-14T08:30:00+00:00',
      source: 'declaration',
    }
    expect(resolveRunAgiSubmission(filedRun, record)).toBe(record)
    expect(resolveRunAgiKvittensnummer(filedRun, record)).toBe('K1')
    expect(deriveAgiFilingState(filedRun, record)).toBe('signed')
  })

  it('without signeradTid the reconciliation-time stamp decides ownership', () => {
    // Skatteverket omitted signeradTid: the reconciler stamped both the
    // declaration and the run row with its own clock, and the record says so.
    const estimated: AgiSubmissionState = {
      status: 'signed',
      kvittensnummer: 'K1',
      signeradAv: '191212121212',
      submittedAt: '2026-07-14T08:30:00+00:00',
      submittedAtEstimated: true,
      updatedAt: '2026-07-14T08:30:00+00:00',
      source: 'declaration',
    }
    expect(resolveRunAgiSubmission(filedRun, estimated)).toBe(estimated)

    // A stamp from another moment is another declaration's receipt.
    const otherRun: AgiFilingRun = { ...filedRun, agi_submitted_at: '2026-06-01T10:00:00Z' }
    expect(resolveRunAgiSubmission(otherRun, estimated)).toBeNull()
    expect(resolveRunAgiKvittensnummer(otherRun, estimated)).toBeNull()
  })

  it('a correction run generated after the receipt does not inherit it', () => {
    // The declaration row now points at the correction run, which is exactly
    // why the record carries no salaryRunId: updatedAt (= submitted_at)
    // predates the correction's XML, so it belongs to the original.
    const record: AgiSubmissionState = {
      status: 'signed',
      kvittensnummer: 'K1',
      signeradTid: '2026-07-14T08:30:00Z',
      submittedAt: '2026-07-14T08:30:00+00:00',
      updatedAt: '2026-07-14T08:30:00+00:00',
      source: 'declaration',
    }
    const correction: AgiFilingRun = {
      id: 'r2',
      agi_generated_at: '2026-07-20T09:00:00Z',
      agi_submitted_at: null,
    }
    expect(resolveRunAgiSubmission(correction, record)).toBeNull()
    expect(deriveAgiFilingState(correction, record)).toBe('generated')
    // The original keeps its number.
    expect(resolveRunAgiKvittensnummer(filedRun, record)).toBe('K1')
  })
})

/**
 * The salary run page (`app/(dashboard)/salary/runs/[id]/page.tsx`) and the
 * AGI panel (`components/salary/AGIPanel.tsx`) read the same period-scoped
 * record at TWO different scopes, and getting the split wrong is the bug this
 * module exists to prevent. Components are not rendered in this repo's test
 * suite (vitest runs in `node`), so the two derivations are mirrored here and
 * pinned against the correction timeline.
 */
describe('run page and AGI panel derivations', () => {
  /**
   * Mirrors AGIPanel. The in-flight machine stays PERIOD-scoped because
   * Skatteverket locks a redovisningsperiod, not a run: the granskningsunderlag
   * and lasUpp calls address the period, so a correction has to be able to see
   * (and release) the draft that is blocking it. The filing receipt is
   * RUN-scoped: a correction is a complete replacement declaration and gets its
   * own kvittens.
   */
  function panelView(run: AgiFilingRun, submission: AgiSubmissionState | null) {
    const runSubmission = resolveRunAgiSubmission(run, submission)
    return {
      // Period scope: gates the signing-link card, the stale-draft warning and
      // the "Lås upp" recovery button.
      awaitingSigning: submission?.status === 'awaiting_signing',
      underlagSubmitted: submission?.status === 'underlag_submitted',
      // Run scope: gates the success card and hides the filing actions.
      isSigned: runSubmission?.status === 'signed' || !!run.agi_submitted_at,
      kvittens: runSubmission?.kvittensnummer ?? null,
      signeradAv: runSubmission?.signeradAv ?? null,
    }
  }

  /** Mirrors RunProgressBar: the kvittens renders only on the signed step. */
  function railAgiStep(run: AgiFilingRun, submission: AgiSubmissionState | null) {
    const state = deriveAgiFilingState(run, submission)
    return {
      state,
      kvittens: state === 'signed' ? resolveRunAgiKvittensnummer(run, submission) : null,
    }
  }

  const T0 = '2026-07-13T09:00:00Z' // original generates XML
  const T1 = '2026-07-13T10:00:00Z' // original signs, kvittens K1
  const T2 = '2026-07-20T11:00:00Z' // correction generates XML
  const T3 = '2026-07-20T12:00:00Z' // correction signs, kvittens K2

  const ORIGINAL_ID = '11111111-1111-4111-8111-111111111111'
  const CORRECTION_ID = '22222222-2222-4222-8222-222222222222'

  const originalFiled: AgiFilingRun = {
    id: ORIGINAL_ID,
    agi_generated_at: T0,
    agi_submitted_at: T1,
  }
  const signedK1: AgiSubmissionState = {
    status: 'signed',
    kvittensnummer: 'K1',
    signeradAv: '199001011234',
    signeradTid: T1,
    updatedAt: T1,
  }
  const signedK2: AgiSubmissionState = {
    status: 'signed',
    kvittensnummer: 'K2',
    signeradAv: '199001011234',
    signeradTid: T3,
    updatedAt: T3,
  }

  it('state 1: the original run before any correction shows its own receipt', () => {
    expect(panelView(originalFiled, signedK1)).toEqual({
      awaitingSigning: false,
      underlagSubmitted: false,
      isSigned: true,
      kvittens: 'K1',
      signeradAv: '199001011234',
    })
    expect(railAgiStep(originalFiled, signedK1)).toEqual({ state: 'signed', kvittens: 'K1' })
  })

  it('state 2: a correction run with no XML yet is not filed and offers the actions', () => {
    const correction: AgiFilingRun = {
      id: CORRECTION_ID,
      agi_generated_at: null,
      agi_submitted_at: null,
    }
    // isSigned false is what re-enables the filing buttons: they are hidden
    // behind `!isSigned`, so the previous period-scoped read left a correction
    // with no way to file at all.
    expect(panelView(correction, signedK1)).toEqual({
      awaitingSigning: false,
      underlagSubmitted: false,
      isSigned: false,
      kvittens: null,
      signeradAv: null,
    })
    expect(railAgiStep(correction, signedK1)).toEqual({ state: 'none', kvittens: null })
  })

  it('state 3: a correction run that has filed shows its own kvittens, never K1', () => {
    const correctionFiled: AgiFilingRun = {
      id: CORRECTION_ID,
      agi_generated_at: T2,
      agi_submitted_at: T3,
    }
    expect(panelView(correctionFiled, signedK2).kvittens).toBe('K2')
    expect(panelView(correctionFiled, signedK2).isSigned).toBe(true)
    expect(railAgiStep(correctionFiled, signedK2)).toEqual({ state: 'signed', kvittens: 'K2' })
  })

  it('state 4: the original after the correction filed stays filed, without K2', () => {
    // The cache now holds the correction's receipt. The original really did
    // file, so it keeps the success card, but printing K2 there would attribute
    // the replacement declaration's receipt to the declaration it replaced.
    const view = panelView(originalFiled, signedK2)
    expect(view.isSigned).toBe(true)
    expect(view.kvittens).toBeNull()
    expect(view.signeradAv).toBeNull()
    expect(railAgiStep(originalFiled, signedK2)).toEqual({ state: 'signed', kvittens: null })
  })

  it('the ordinary single-run month is untouched at every step', () => {
    const run: AgiFilingRun = { id: ORIGINAL_ID, agi_generated_at: T0, agi_submitted_at: null }

    expect(railAgiStep({ ...run, agi_generated_at: null }, null).state).toBe('none')
    expect(railAgiStep(run, null).state).toBe('generated')

    // /agi/submit writes salaryRunId, so the in-flight phase matches exactly.
    const underlag: AgiSubmissionState = {
      status: 'underlag_submitted',
      salaryRunId: ORIGINAL_ID,
      inlamningId: 4711,
      updatedAt: T0,
    }
    expect(panelView(run, underlag).underlagSubmitted).toBe(true)
    expect(railAgiStep(run, underlag).state).toBe('underlag_submitted')

    // skapaGranskningsunderlag drops salaryRunId; the record is younger than
    // the run's XML, so it still resolves to this run.
    const awaiting: AgiSubmissionState = {
      status: 'awaiting_signing',
      signeringslank: 'https://sso.skatteverket.se/x',
      updatedAt: T1,
    }
    expect(panelView(run, awaiting).awaitingSigning).toBe(true)
    expect(railAgiStep(run, awaiting).state).toBe('awaiting_signing')

    // Signed: kvittens on the panel and on the rail.
    const filed: AgiFilingRun = { ...run, agi_submitted_at: T1 }
    expect(panelView(filed, signedK1).kvittens).toBe('K1')
    expect(railAgiStep(filed, signedK1)).toEqual({ state: 'signed', kvittens: 'K1' })
  })

  it('keeps the stale-draft recovery reachable when the run regenerates its XML', () => {
    // "Ladda ner AGI-fil" re-runs generateAgiDeclaration, which re-stamps
    // agi_generated_at unconditionally. A single click while a draft is locked
    // therefore pushes the run's XML past the draft, and the run-scoped
    // resolution stops claiming the record. The period-scoped read must keep
    // the signing-link / stale-draft / "Lås upp" trio on screen anyway: the
    // period is genuinely still locked at Skatteverket. This is why the panel
    // narrows the record for the receipt only, instead of taking a narrowed
    // record as its `submission` prop.
    const run: AgiFilingRun = { id: ORIGINAL_ID, agi_generated_at: T2, agi_submitted_at: null }
    const lockedDraft: AgiSubmissionState = {
      status: 'awaiting_signing',
      signeringslank: 'https://sso.skatteverket.se/x',
      updatedAt: T1,
    }
    expect(resolveRunAgiSubmission(run, lockedDraft)).toBeNull()
    expect(panelView(run, lockedDraft).awaitingSigning).toBe(true)
    expect(panelView(run, lockedDraft).isSigned).toBe(false)
  })
})
