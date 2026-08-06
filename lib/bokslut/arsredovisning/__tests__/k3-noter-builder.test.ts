import { describe, it, expect } from 'vitest'
import {
  anyAssetHasComponents,
  buildEquityChangesNote,
  buildK3RedovisningsPrinciper,
  buildMateriellaAnlaggningsNot,
  buildUppskjutenSkattNot,
} from '../k3-noter-builder'

/** Default: no komponentavskrivning, no legacy 2240 balance. */
function principles(
  overrides: Partial<{
    hasComponents: boolean
    deferredTax: 'none' | 'recognized' | 'unknown'
    hasCapitalizedLease: boolean
  }> = {},
) {
  return buildK3RedovisningsPrinciper({
    hasComponents: false,
    deferredTax: 'none',
    hasCapitalizedLease: false,
    ...overrides,
  })
}

describe('buildK3RedovisningsPrinciper', () => {
  it('always includes the K3 framework citation and the standard policy paragraphs', () => {
    const note = principles()
    expect(note.number).toBe(1)
    expect(note.title).toBe('Redovisnings- och värderingsprinciper')
    expect(note.body).toContain('BFNAR 2012:1')
    expect(note.body).toContain('Uppskjuten skatt')
    expect(note.body).toContain('Intäktsredovisning')
    expect(note.body).toContain('Leasing')
    expect(note.body).toContain('Finansiella instrument')
  })

  it('describes uppskjuten skatt per K3 29.37: not separately recognised in juridisk person', () => {
    const note = principles()
    // The engine books NO deferred tax on obeskattade reserver (K3 29.37:
    // gross in juridisk person; the split belongs to koncernredovisning).
    // The note states that policy and must not claim balansrakningsmetoden
    // or any recognised uppskjuten skatteskuld on the reserves.
    expect(note.body).toContain('särredovisas inte i juridisk person')
    expect(note.body).toContain('inklusive uppskjuten skatteskuld')
    expect(note.body).not.toMatch(/balansräkningsmetoden/)
    expect(note.body).not.toMatch(/temporära skillnader mellan redovisade och skattemässiga värden/)
    // With no 2240 balance the note must not reference one.
    expect(note.body).not.toMatch(/2240/)
  })

  it('discloses the recognised 2240 liability instead when the books carry one', () => {
    const note = principles({ deferredTax: 'recognized' })
    expect(note.body).toContain('konto 2240')
    expect(note.body).toContain('Uppskjutna skatter')
    // The gross-reserve claim is the OTHER branch: keeping it here would
    // deny the liability disclosed two notes down.
    expect(note.body).not.toContain('särredovisas inte')
    // The builder cannot know how an imported or legacy provision was
    // measured, so the paragraph asserts no rate and no origin.
    expect(note.body).not.toMatch(/20,6/)
    expect(note.body).not.toMatch(/beräknad/)
  })

  it('does not attribute the recognised 2240 balance to obeskattade reserver', () => {
    // deriveLatentTaxMovement reads the 2240 and 8940 balances and nothing
    // else. Under K3 that account carries deferred tax on ALL temporary
    // differences (k2-vs-k3.md:11-13), so where the balance came from is
    // exactly what this builder cannot establish.
    const note = principles({ deferredTax: 'recognized' })
    expect(note.body).toContain('Uppskjuten skatteskuld redovisas på konto 2240')
    expect(note.body).not.toContain('hänförlig till obeskattade reserver')
  })

  it('describes leasing as expensed operational leases under the K3 20.29 juridisk-person exemption', () => {
    const note = principles()
    expect(note.body).toContain('operationella leasingavtal')
    expect(note.body).toContain('kostnadsförs linjärt')
    // The blanket operational treatment is only available to a juridisk
    // person (K3 punkt 20.29); it is not the general K3 rule, so the note
    // must state the basis it relies on.
    expect(note.body).toContain('juridisk person')
    expect(note.body).toContain('K3 punkt 20.29')
    // It must NOT assert anything about the entity's group obligations: the
    // same document emits a Koncernforhallanden note when a parent is set.
    expect(note.body).not.toMatch(/koncernredovisning upprättas inte/)
    // No code capitalizes leases, so the note must not assert that finance
    // leases are recognized as assets with a corresponding liability.
    expect(note.body).not.toMatch(/anläggningstillgång med motsvarande skuld/)
  })

  it('drops the blanket operational claim when the books carry leased assets', () => {
    const note = principles({ hasCapitalizedLease: true })
    // A balansrakning carrying an anlaggningskonto the company's own chart
    // names as leased contradicts "samtliga leasingavtal redovisas som
    // operationella", so that claim and the 20.29 basis for it must both
    // disappear; the paragraph describes what is booked instead.
    expect(note.body).not.toMatch(/Samtliga leasingavtal/)
    expect(note.body).not.toMatch(/20\.29/)
    expect(note.body).toContain('leasade tillgångar')
    expect(note.body).toContain('kostnadsförs linjärt')
  })

  it('prints NO deferred-tax paragraph when the figures could not be read', () => {
    const note = principles({ deferredTax: 'unknown' })
    // Every available wording is a statement about how THIS document reports
    // the reserves, and on the read-failure path there are no figures to state
    // it from: the gross wording is the denial phrased positively, not a
    // weaker claim. So the paragraph is omitted entirely; build-data has
    // already pushed a warning that the note could not be computed.
    expect(note.body).not.toMatch(/Uppskjuten skatt/)
    expect(note.body).not.toMatch(/29\.37/)
    expect(note.body).not.toMatch(/uppskjuten skatteskuld/)
    expect(note.body).not.toMatch(/2240/)
    // The rest of the policy note is unaffected.
    expect(note.body).toContain('BFNAR 2012:1')
    expect(note.body).toContain('Intäktsredovisning')
    expect(note.body).toContain('Leasing')
    expect(note.body).toContain('Finansiella instrument')
  })

  it('OMITS the komponentavskrivning paragraph when no asset has components', () => {
    const note = principles()
    expect(note.body).not.toMatch(/Komponentavskrivning/)
  })

  it('INCLUDES the komponentavskrivning paragraph when an asset has components', () => {
    const note = principles({ hasComponents: true })
    expect(note.body).toMatch(/Komponentavskrivning/)
    expect(note.body).toMatch(/betydande komponenter/)
  })
})

describe('K3 noter: the two deferred-tax notes never contradict each other', () => {
  it('company WITHOUT a legacy 2240 balance: policy denies the split and no movement note exists', () => {
    // build-data omits buildUppskjutenSkattNot entirely when the trial
    // balance has no 2240/8940 activity, so the only deferred-tax statement
    // in the document is the policy paragraph.
    const note = principles({ deferredTax: 'none' })
    expect(note.body).toContain(
      'Uppskjuten skatt hänförlig till obeskattade reserver särredovisas inte i juridisk person',
    )
    expect(note.body).not.toMatch(/2240/)
    expect(note.body).not.toMatch(/8940/)
  })

  it('company WITH a 2240 balance: policy paragraph and movement note tell one story', () => {
    const policy = principles({ deferredTax: 'recognized' })
    const movement = buildUppskjutenSkattNot({
      noteNumber: 4,
      latentTaxOpening: 50_000,
      latentTaxChange: 20_600,
      latentTaxClosing: 70_600,
    })
    // Both notes recognise the same liability on the same account, and
    // neither says where the balance came from: the caller sees 2240/8940
    // only, and K3 puts every temporary difference on 2240.
    expect(policy.body).toContain('konto 2240')
    expect(movement.body).toContain('konto 2240')
    expect(policy.body).not.toContain('hänförlig till obeskattade reserver')
    expect(movement.body).not.toContain('hänförlig till obeskattade reserver')
    // The policy paragraph must NOT carry the denial while the movement note
    // discloses exactly that split: that is the contradiction this pins.
    expect(policy.body).not.toContain('särredovisas inte')
    expect(policy.body).not.toContain(
      'obeskattade reserver redovisas inklusive uppskjuten skatteskuld',
    )
    // Neither note asserts a measurement rate for a balance whose origin
    // (K3 disposition, legacy posting, SIE import) the builder cannot see.
    expect(policy.body).not.toMatch(/20,6/)
    expect(movement.body).not.toMatch(/20,6/)
  })
})

describe('buildUppskjutenSkattNot', () => {
  it('renders opening + change + closing line in the body', () => {
    const note = buildUppskjutenSkattNot({
      noteNumber: 4,
      latentTaxOpening: 50_000,
      latentTaxChange: 20_600,
      latentTaxClosing: 70_600,
    })
    expect(note.number).toBe(4)
    expect(note.title).toBe('Uppskjutna skatter')
    // sv-SE thousand separator uses non-breaking space (\u00A0)
    expect(note.body).toMatch(/Ingående saldo.*50/)
    expect(note.body).toMatch(/Årets förändring.*20/)
    expect(note.body).toMatch(/Utgående saldo.*70/)
  })

  it('handles zero values without producing NaN strings', () => {
    const note = buildUppskjutenSkattNot({
      noteNumber: 2,
      latentTaxOpening: 0,
      latentTaxChange: 0,
      latentTaxClosing: 0,
    })
    expect(note.body).not.toMatch(/NaN/)
    expect(note.body).toMatch(/0 kr/)
  })

  it('handles a negative change (återföring)', () => {
    const note = buildUppskjutenSkattNot({
      noteNumber: 3,
      latentTaxOpening: 70_600,
      latentTaxChange: -10_000,
      latentTaxClosing: 60_600,
    })
    // Swedish locale formats negative numbers with the Unicode minus sign
    // (U+2212), not the ASCII hyphen-minus: match either to be robust.
    expect(note.body).toMatch(/[-−]10/)
    expect(note.body).toMatch(/Ingående saldo.*70/)
    expect(note.body).toMatch(/Utgående saldo.*60/)
  })

  it('reports the balance without claiming a rate or an origin it cannot verify', () => {
    const note = buildUppskjutenSkattNot({
      noteNumber: 1,
      latentTaxOpening: 50_000,
      latentTaxChange: 0,
      latentTaxClosing: 50_000,
    })
    expect(note.body).toContain('konto 2240')
    // A balance can come from the K3 disposition, a legacy posting or an SIE
    // import measured at 22 or 21,4 percent: asserting 20,6 percent would be
    // a claim about numbers this builder did not produce.
    expect(note.body).not.toMatch(/20,6/)
    expect(note.body).not.toMatch(/skattesats/)
    // Same for provenance: 2240 is K3's account for every temporary
    // difference (k2-vs-k3.md:11-13), and the caller reads only the balance.
    expect(note.body).not.toContain('obeskattade reserver')
  })
})

describe('buildEquityChangesNote', () => {
  it('reconciles opening + changes to closing total', () => {
    const result = buildEquityChangesNote({
      opening: {
        aktiekapital: 50_000,
        bundna_reserver: 10_000,
        balanserade_vinstmedel: 100_000,
      },
      changes: {
        nyemission: 25_000,
        utdelning: -15_000,
        arets_resultat: 80_000,
      },
    })
    // 50 000 + 10 000 + 100 000 + 25 000 - 15 000 + 80 000 = 250 000
    expect(result.closing_total).toBe(250_000)
  })

  it('emits rows for each opening component plus changes plus closing', () => {
    const result = buildEquityChangesNote({
      opening: {
        aktiekapital: 50_000,
        bundna_reserver: 0,
        balanserade_vinstmedel: 100_000,
      },
      changes: {
        nyemission: 25_000,
        utdelning: -15_000,
        arets_resultat: 80_000,
      },
    })
    const labels = result.rows.map((r) => r.label)
    expect(labels).toContain('Ingående aktiekapital')
    expect(labels).toContain('Ingående balanserade vinstmedel')
    expect(labels).toContain('Nyemission')
    expect(labels).toContain('Utdelning')
    expect(labels).toContain('Årets resultat')
    expect(labels).toContain('Summa utgående eget kapital')
  })

  it('OMITS the nyemission row when no nyemission happened (cleaner statement)', () => {
    const result = buildEquityChangesNote({
      opening: {
        aktiekapital: 50_000,
        bundna_reserver: 0,
        balanserade_vinstmedel: 100_000,
      },
      changes: {
        nyemission: 0,
        utdelning: -15_000,
        arets_resultat: 80_000,
      },
    })
    const labels = result.rows.map((r) => r.label)
    expect(labels).not.toContain('Nyemission')
    // Utdelning + årets resultat still present
    expect(labels).toContain('Utdelning')
    expect(labels).toContain('Årets resultat')
  })

  it('OMITS the utdelning row when no utdelning happened', () => {
    const result = buildEquityChangesNote({
      opening: {
        aktiekapital: 50_000,
        bundna_reserver: 0,
        balanserade_vinstmedel: 100_000,
      },
      changes: {
        nyemission: 0,
        utdelning: 0,
        arets_resultat: 80_000,
      },
    })
    const labels = result.rows.map((r) => r.label)
    expect(labels).not.toContain('Nyemission')
    expect(labels).not.toContain('Utdelning')
    // Årets resultat always shown: even when zero: so the year-end
    // disposition is visible in the statement.
    expect(labels).toContain('Årets resultat')
  })

  it('handles all-zero opening + changes without crashing', () => {
    const result = buildEquityChangesNote({
      opening: { aktiekapital: 0, bundna_reserver: 0, balanserade_vinstmedel: 0 },
      changes: { nyemission: 0, utdelning: 0, arets_resultat: 0 },
    })
    expect(result.closing_total).toBe(0)
    expect(result.rows.length).toBeGreaterThan(0)
  })
})

describe('buildMateriellaAnlaggningsNot', () => {
  it('returns null when there are no tangible assets', () => {
    const note = buildMateriellaAnlaggningsNot({
      noteNumber: 5,
      assets: [],
    })
    expect(note).toBeNull()
  })

  it('returns null when only immaterial assets exist (they belong in a separate note)', () => {
    const note = buildMateriellaAnlaggningsNot({
      noteNumber: 5,
      assets: [
        {
          name: 'Software License',
          category: 'immaterial',
          acquisition_date: '2025-01-01',
          acquisition_cost: 50_000,
          k3_components: null,
          disposed_at: null,
          useful_life_months: 60,
        },
      ],
    })
    expect(note).toBeNull()
  })

  it('emits the avskrivningstider summary for tangible assets without components', () => {
    const note = buildMateriellaAnlaggningsNot({
      noteNumber: 3,
      assets: [
        {
          name: 'Macbook Pro',
          category: 'computer',
          acquisition_date: '2025-01-01',
          acquisition_cost: 30_000,
          k3_components: null,
          disposed_at: null,
          useful_life_months: 36, // 3 år
        },
        {
          name: 'Skrivbord',
          category: 'equipment',
          acquisition_date: '2025-01-01',
          acquisition_cost: 5_000,
          k3_components: null,
          disposed_at: null,
          useful_life_months: 60, // 5 år
        },
      ],
    })
    expect(note).not.toBeNull()
    expect(note!.title).toBe('Materiella anläggningstillgångar')
    expect(note!.body).toMatch(/Datorer: 3 år/)
    expect(note!.body).toMatch(/Inventarier: 5 år/)
    // Should NOT mention komponentuppdelning since no components were given
    expect(note!.body).not.toMatch(/Komponentuppdelning/)
  })

  it('renders per-component sub-totals when an asset has K3 components', () => {
    const note = buildMateriellaAnlaggningsNot({
      noteNumber: 3,
      assets: [
        {
          name: 'Lokalbyggnad Sjövägen 12',
          category: 'building',
          acquisition_date: '2020-01-01',
          acquisition_cost: 5_000_000,
          k3_components: [
            {
              name: 'Stomme',
              acquisition_cost: 3_000_000,
              accumulated_depreciation: 300_000,
              useful_life_months: 600, // 50 år
            },
            {
              name: 'Tak',
              acquisition_cost: 800_000,
              accumulated_depreciation: 200_000,
              useful_life_months: 360, // 30 år
            },
            {
              name: 'Installationer',
              acquisition_cost: 1_200_000,
              accumulated_depreciation: 600_000,
              useful_life_months: 240, // 20 år
            },
          ],
          disposed_at: null,
          useful_life_months: 600,
        },
      ],
    })
    expect(note).not.toBeNull()
    expect(note!.body).toMatch(/Komponentuppdelning/)
    expect(note!.body).toMatch(/Stomme/)
    expect(note!.body).toMatch(/Tak/)
    expect(note!.body).toMatch(/Installationer/)
    // Per-component totals must reconcile: 3,000,000 + 800,000 + 1,200,000 = 5,000,000
    // Look for the summary line
    expect(note!.body).toMatch(/Summa:/)
    // Total acquisition cost text (with sv-SE separator)
    // Just confirm 5 000 000 appears as a sub-total somewhere
    expect(note!.body).toMatch(/5\s?000\s?000/)
  })

  it('skips disposed assets in the calculation', () => {
    const note = buildMateriellaAnlaggningsNot({
      noteNumber: 3,
      assets: [
        {
          name: 'Old Macbook',
          category: 'computer',
          acquisition_date: '2020-01-01',
          acquisition_cost: 20_000,
          k3_components: null,
          disposed_at: '2025-06-01',
          useful_life_months: 36,
        },
      ],
    })
    expect(note).toBeNull()
  })
})

describe('anyAssetHasComponents', () => {
  it('returns false for empty array', () => {
    expect(anyAssetHasComponents([])).toBe(false)
  })

  it('returns false when no asset has a components array', () => {
    expect(
      anyAssetHasComponents([
        {
          name: 'X',
          category: 'computer',
          acquisition_date: '2025-01-01',
          acquisition_cost: 1000,
          k3_components: null,
          disposed_at: null,
          useful_life_months: 36,
        },
      ]),
    ).toBe(false)
  })

  it('returns true when at least one asset has a valid components array', () => {
    expect(
      anyAssetHasComponents([
        {
          name: 'Y',
          category: 'building',
          acquisition_date: '2025-01-01',
          acquisition_cost: 1_000_000,
          k3_components: [
            {
              name: 'Stomme',
              acquisition_cost: 800_000,
              accumulated_depreciation: 0,
              useful_life_months: 600,
            },
          ],
          disposed_at: null,
          useful_life_months: 600,
        },
      ]),
    ).toBe(true)
  })

  it('ignores disposed assets when checking for components', () => {
    expect(
      anyAssetHasComponents([
        {
          name: 'Sold Building',
          category: 'building',
          acquisition_date: '2020-01-01',
          acquisition_cost: 1_000_000,
          k3_components: [
            {
              name: 'Stomme',
              acquisition_cost: 800_000,
              accumulated_depreciation: 0,
              useful_life_months: 600,
            },
          ],
          disposed_at: '2025-06-01',
          useful_life_months: 600,
        },
      ]),
    ).toBe(false)
  })

  it('rejects malformed component payloads (typeguard)', () => {
    expect(
      anyAssetHasComponents([
        {
          name: 'Bad data',
          category: 'building',
          acquisition_date: '2025-01-01',
          acquisition_cost: 1_000_000,
          // Missing required fields
          k3_components: [{ name: 'Stomme' }],
          disposed_at: null,
          useful_life_months: 600,
        },
      ]),
    ).toBe(false)
  })
})
