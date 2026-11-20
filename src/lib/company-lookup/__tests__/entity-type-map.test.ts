import { afterEach, describe, it, expect, vi } from 'vitest'
import { mapEntityType, mapPlannedLegalForm, mapSetupEntityType, plannedLegalFormOfSnapshot } from '../entity-type-map'

describe('mapEntityType', () => {
  it('maps the exact AB codes and labels to aktiebolag', () => {
    expect(mapEntityType('AB')).toBe('aktiebolag')
    expect(mapEntityType('ab')).toBe('aktiebolag')
    expect(mapEntityType('Aktiebolag')).toBe('aktiebolag')
    expect(mapEntityType('Publikt aktiebolag')).toBe('aktiebolag') // same K2/K3 regime
    expect(mapEntityType('  Aktiebolag  ')).toBe('aktiebolag') // whitespace tolerant
  })

  it('maps the exact EF codes and labels to enskild_firma', () => {
    expect(mapEntityType('EF')).toBe('enskild_firma')
    expect(mapEntityType('ef')).toBe('enskild_firma')
    expect(mapEntityType('Enskild firma')).toBe('enskild_firma')
    expect(mapEntityType('Enskild näringsidkare')).toBe('enskild_firma')
  })

  it('returns null for unsupported entity types', () => {
    expect(mapEntityType('HB')).toBeNull()
    expect(mapEntityType('Handelsbolag')).toBeNull()
    expect(mapEntityType('KB')).toBeNull()
    expect(mapEntityType('Kommanditbolag')).toBeNull()
    expect(mapEntityType('Stiftelse')).toBeNull()
  })

  it('does not false-match strings that merely contain "enskild" or "aktiebolag"', () => {
    // Regression guard: a loose substring match would misclassify these and
    // provision them with K1/kontantmetoden defaults (ML/BFL risk).
    expect(mapEntityType('Enskild stiftelse')).toBeNull()
    expect(mapEntityType('Enskild näringsverksamhet utan firma')).toBeNull()
    // Bank- and försäkringsaktiebolag follow FFFS, not K2/K3: not a safe
    // one-click provision.
    expect(mapEntityType('Försäkringsaktiebolag')).toBeNull()
    expect(mapEntityType('Bankaktiebolag')).toBeNull()
  })

  it('returns null for empty or nullish input', () => {
    expect(mapEntityType('')).toBeNull()
    expect(mapEntityType(null)).toBeNull()
    expect(mapEntityType(undefined)).toBeNull()
  })
})

describe('mapSetupEntityType: only creatable forms are prefilled', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps ideell förening only when the creation flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', '')
    expect(mapSetupEntityType('Ideell förening')).toBeNull()
    expect(mapSetupEntityType('Aktiebolag')).toBe('aktiebolag')
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    expect(mapSetupEntityType('Ideell förening')).toBe('ideell_forening')
  })

  it('maps bostadsrättsförening only when the creation flag is on, never as an ekonomisk förening', () => {
    vi.stubEnv('NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', 'true')
    expect(mapEntityType('Bostadsrättsförening')).toBe('bostadsrattsforening')
    expect(mapEntityType('BRF')).toBe('bostadsrattsforening')
    expect(mapSetupEntityType('Bostadsrättsförening')).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED', 'true')
    expect(mapSetupEntityType('Bostadsrättsförening')).toBe('bostadsrattsforening')
  })

  it('maps ekonomisk förening only when the creation flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', '')
    expect(mapSetupEntityType('Ekonomisk förening')).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', 'true')
    expect(mapSetupEntityType('Ekonomisk förening')).toBe('ekonomisk_forening')
  })
})

describe('mapPlannedLegalForm: the scoped-but-not-creatable forms', () => {
  it('maps the registry spellings to the planned form and its label', () => {
    expect(mapPlannedLegalForm('Samfällighetsförening')).toMatchObject({
      code: 'samfallighetsforening',
      label: 'Samfällighetsförening',
    })
    // A shipped form is never planned: behind its flag the journey stops on
    // it through mapEntityType instead.
    expect(mapPlannedLegalForm('Ekonomisk förening')).toBeNull()
    expect(mapPlannedLegalForm('Bostadsrättsförening')).toBeNull()
    expect(mapPlannedLegalForm('BRF')).toBeNull()
    expect(mapPlannedLegalForm('Stiftelse')?.code).toBe('stiftelse')
    expect(mapPlannedLegalForm('Annan stiftelse')?.code).toBe('stiftelse')
  })

  it('stops a handelsbolag or kommanditbolag instead of offering the aktiebolag chart (PH 207)', () => {
    expect(mapPlannedLegalForm('Handelsbolag')).toMatchObject({ code: 'handelsbolag', label: 'Handelsbolag' })
    expect(mapPlannedLegalForm('HB')?.code).toBe('handelsbolag')
    expect(mapPlannedLegalForm('Kommanditbolag')).toMatchObject({ code: 'kommanditbolag', label: 'Kommanditbolag' })
    expect(mapPlannedLegalForm('KB')?.code).toBe('kommanditbolag')
    // SCB legal form 31 is one code for both.
    expect(mapPlannedLegalForm('Handelsbolag eller kommanditbolag')?.code).toBe('handelsbolag')
    expect(mapEntityType('Kommanditbolag')).toBeNull()
  })

  it('never maps a creatable form, an unrelated form or a loose substring', () => {
    expect(mapPlannedLegalForm('Aktiebolag')).toBeNull()
    expect(mapPlannedLegalForm('Ideell förening')).toBeNull()
    expect(mapPlannedLegalForm('Registrerat trossamfund')).toBeNull()
    expect(mapPlannedLegalForm('Enskild stiftelse')).toBeNull()
    expect(mapPlannedLegalForm('')).toBeNull()
    expect(mapPlannedLegalForm(null)).toBeNull()
  })
})

describe('mapEntityType: ideell förening (issue #2072)', () => {
  it('maps the registry spelling of ideell förening', () => {
    expect(mapEntityType('Ideell förening')).toBe('ideell_forening')
    expect(mapEntityType('ideell forening')).toBe('ideell_forening')
  })

  it('does not map other föreningar or stiftelser', () => {
    expect(mapEntityType('Bostadsrättsförening')).not.toBe('ideell_forening')
    expect(mapEntityType('Registrerat trossamfund')).toBeNull()
    expect(mapEntityType('Stiftelse')).toBeNull()
  })
})

describe('mapEntityType: ekonomisk förening', () => {
  it('maps only the registry spellings of ekonomisk förening', () => {
    expect(mapEntityType('Ekonomisk förening')).toBe('ekonomisk_forening')
    expect(mapEntityType('ekonomisk forening')).toBe('ekonomisk_forening')
    expect(mapEntityType('Ekonomiska föreningar')).toBe('ekonomisk_forening')
  })

  it('does not map specially regulated or adjacent association forms', () => {
    expect(mapEntityType('Bostadsrättsförening')).not.toBe('ekonomisk_forening')
    expect(mapEntityType('Kooperativ hyresrättsförening')).toBeNull()
    expect(mapEntityType('Sambruksförening')).toBeNull()
  })
})

describe('plannedLegalFormOfSnapshot: the registry form a company set up as another form carries (PH 237)', () => {
  it('reads the snapshot legalEntityType through mapPlannedLegalForm', () => {
    expect(plannedLegalFormOfSnapshot({ legalEntityType: 'Kommanditbolag', registration: { vat: true } })).toMatchObject({
      code: 'kommanditbolag',
      label: 'Kommanditbolag',
    })
    expect(plannedLegalFormOfSnapshot({ legalEntityType: 'Handelsbolag' })?.code).toBe('handelsbolag')
  })

  it('is null for a supported form, a missing or malformed snapshot', () => {
    expect(plannedLegalFormOfSnapshot({ legalEntityType: 'Aktiebolag' })).toBeNull()
    expect(plannedLegalFormOfSnapshot({ legalEntityType: 'Enskild näringsidkare' })).toBeNull()
    expect(plannedLegalFormOfSnapshot({ legalEntityType: 42 })).toBeNull()
    expect(plannedLegalFormOfSnapshot({})).toBeNull()
    expect(plannedLegalFormOfSnapshot(null)).toBeNull()
    expect(plannedLegalFormOfSnapshot('Kommanditbolag')).toBeNull()
  })
})
