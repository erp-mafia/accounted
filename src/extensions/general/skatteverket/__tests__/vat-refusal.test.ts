/**
 * The reader of a refused Momsdeklaration call (lib/vat-refusal.ts): what
 * Skatteverket answered becomes a Swedish sentence and the same answer in
 * fields. The bodies below are the shapes Skatteverket's API description
 * gives (momsdeklaration 1.0.24), plus the ones it does not.
 */
import { describe, expect, it } from 'vitest'
import { describeKontrollErrors, readVatRefusal } from '../lib/vat-refusal'

function refused(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

const E_SERVICE = 'Går det fortfarande inte kan deklarationen lämnas direkt i Skatteverkets e-tjänst.'

describe('readVatRefusal: Skatteverket\'s own envelope', () => {
  // crm#1866: a 400 whose envelope held no message read as an empty error.
  it('says plainly that Skatteverket gave no reason when both messages are null', async () => {
    const refusal = await readVatRefusal(
      refused(400, { kod: 400, meddelandeTillAnvandare: null, meddelandeTillUtvecklare: null }),
      'draft',
    )

    expect(refusal.status).toBe(400)
    expect(refusal.message).toBe(
      `Skatteverket tog inte emot utkastet och angav ingen orsak (svarskod 400). Försök igen om en stund. ${E_SERVICE}`,
    )
    expect(refusal.message).not.toContain('{')
    expect(refusal.details).toEqual({ skv_step: 'draft', skv_status: 400, skv_kod: 400 })
  })

  it('gives both of Skatteverket\'s messages verbatim, and in fields', async () => {
    const refusal = await readVatRefusal(
      refused(400, {
        kod: 400,
        meddelandeTillAnvandare: 'Felaktig formatering av uppgift',
        meddelandeTillUtvecklare: 'Felaktig formatering av periodintervall',
      }),
      'draft',
    )

    expect(refusal.message).toBe(
      'Skatteverket tog inte emot utkastet: Felaktig formatering av uppgift. ' +
        'Skatteverkets detalj: Felaktig formatering av periodintervall. ' +
        `Försök igen om en stund. ${E_SERVICE}`,
    )
    expect(refusal.details).toEqual({
      skv_step: 'draft',
      skv_status: 400,
      skv_kod: 400,
      skv_user_message: 'Felaktig formatering av uppgift',
      skv_developer_message: 'Felaktig formatering av periodintervall',
    })
  })

  it('does not repeat a developer message that says the same as the user message', async () => {
    const refusal = await readVatRefusal(
      refused(409, { kod: 409, meddelandeTillAnvandare: 'Utkastet är låst', meddelandeTillUtvecklare: 'Utkastet är låst' }),
      'draft',
    )

    expect(refusal.message.match(/Utkastet är låst/g)).toHaveLength(1)
  })

  it('uses the developer message when it is the only one', async () => {
    const refusal = await readVatRefusal(
      refused(400, { kod: 400, meddelandeTillAnvandare: null, meddelandeTillUtvecklare: 'Felaktig formatering av periodintervall' }),
      'validate',
    )

    expect(refusal.message).toMatch(
      /^Skatteverket tog inte emot deklarationen för kontroll: Felaktig formatering av periodintervall\. /,
    )
  })

  it('masks a personnummer Skatteverket echoes, in the sentence and in the fields', async () => {
    // The well-known made-up personnummer: an enskild firma's redovisare is the owner's own.
    const refusal = await readVatRefusal(
      refused(404, {
        kod: 404,
        meddelandeTillAnvandare: 'Angiven redovisare [191212121212] kunde inte hittas',
        meddelandeTillUtvecklare: 'Angiven redovisare kunde inte hittas',
      }),
      'draft',
    )

    expect(JSON.stringify(refusal)).not.toContain('191212121212')
    expect(refusal.details.skv_user_message).toBe('Angiven redovisare [19121212-XXXX] kunde inte hittas')
  })
})

describe('readVatRefusal: what to do next follows the status', () => {
  it('a missing period or redovisare (404) points at the organisation number and the momsperiod', async () => {
    const refusal = await readVatRefusal(
      refused(404, {
        kod: 404,
        meddelandeTillAnvandare: 'Period saknas',
        meddelandeTillUtvecklare: 'Ingen redovisningsperiod för [202601] kunde hittas',
      }),
      'draft',
    )

    expect(refusal.message).toBe(
      'Skatteverket tog inte emot utkastet: Period saknas. ' +
        'Skatteverkets detalj: Ingen redovisningsperiod för [202601] kunde hittas. ' +
        'Kontrollera att företagets organisationsnummer och momsperiod (månad, kvartal eller år) stämmer med det Skatteverket har registrerat.',
    )
  })

  it('a locked draft (409) says to sign it or unlock it', async () => {
    const refusal = await readVatRefusal(
      refused(409, {
        kod: 409,
        meddelandeTillAnvandare: 'Begäran kan ej utföras. Angivet utkast för period [202304] är låst',
        meddelandeTillUtvecklare: 'Begäran kan ej utföras. Utkastet är låst',
      }),
      'draft',
    )

    expect(refusal.message).toContain('Angivet utkast för period [202304] är låst.')
    expect(refusal.message).toMatch(/Signera det där, eller lås upp det under Fler åtgärder på momsdeklarationen och skicka igen\.$/)
  })

  it.each([500, 502, 503, 504])('a technical error at Skatteverket (%i) says so and to try again', async (status) => {
    const refusal = await readVatRefusal(
      refused(status, { kod: status, meddelandeTillAnvandare: 'Tekniskt fel', meddelandeTillUtvecklare: 'Service unavailable' }),
      'lock',
    )

    expect(refusal.message).toBe(
      'Skatteverket låste inte utkastet för signering: Tekniskt fel. Skatteverkets detalj: Service unavailable. ' +
        'Skatteverkets tjänst har ett tekniskt fel just nu. Försök igen om en stund.',
    )
  })

  it('a step that files nothing is not told where else to file', async () => {
    const refusal = await readVatRefusal(refused(400, { kod: 400, meddelandeTillAnvandare: null }), 'unlock')

    expect(refusal.message).toBe('Skatteverket låste inte upp utkastet och angav ingen orsak (svarskod 400). Försök igen om en stund.')
  })
})

describe('readVatRefusal: the gateway\'s answer and the boxes it names', () => {
  it('quotes the gateway message and names the box of the field it refuses', async () => {
    const refusal = await readVatRefusal(
      refused(400, { message: '/momsuppgift/momsForsaljningUtgaendeHog expected type: Number, found: String' }),
      'draft',
    )

    expect(refusal.message).toBe(
      'Skatteverket tog inte emot utkastet. ' +
        'Skatteverkets svar: "/momsuppgift/momsForsaljningUtgaendeHog expected type: Number, found: String". ' +
        'Det gäller ruta 10 (Utgående moms 25%). ' +
        `Försök igen om en stund. ${E_SERVICE}`,
    )
    expect(refusal.details).toEqual({
      skv_step: 'draft',
      skv_status: 400,
      skv_gateway_message: '/momsuppgift/momsForsaljningUtgaendeHog expected type: Number, found: String',
      skv_rutor: [{ ruta: '10', label: 'Utgående moms 25%' }],
    })
  })

  it('names several boxes in box order', async () => {
    const refusal = await readVatRefusal(
      refused(400, { message: '/summaMoms is required; /ingaendeMomsAvdrag expected minimum: 0' }),
      'validate',
    )

    expect(refusal.message).toContain(
      'Det gäller ruta 48 (Ingående moms att dra av) och ruta 49 (Moms att betala eller få tillbaka).',
    )
  })

  it('reads the one-word field "import" as a path or a quoted property, never as a word of the sentence', async () => {
    const asPath = await readVatRefusal(refused(400, { message: '/momsuppgift/import expected type: Number' }), 'draft')
    const asWord = await readVatRefusal(refused(400, { message: 'Could not import the request body' }), 'draft')

    expect(asPath.details.skv_rutor).toEqual([{ ruta: '50', label: 'Beskattningsunderlag vid import' }])
    expect(asWord.details.skv_rutor).toBeUndefined()
  })

  it('names the box when Skatteverket points at it by number', async () => {
    const refusal = await readVatRefusal(
      refused(400, { kod: 400, meddelandeTillAnvandare: 'Det måste finnas ett belopp i fält 49.' }),
      'draft',
    )

    expect(refusal.message).toContain(
      'Skatteverket tog inte emot utkastet: Det måste finnas ett belopp i fält 49. Det gäller ruta 49 (Moms att betala eller få tillbaka).',
    )
  })

  it('reads the quota answer the gateway gives under "error"', async () => {
    const refusal = await readVatRefusal(refused(400, { error: 'Quota has been exceeded' }), 'validate')

    expect(refusal.message).toContain('Skatteverkets svar: "Quota has been exceeded".')
    expect(refusal.details.skv_gateway_message).toBe('Quota has been exceeded')
  })
})

describe('readVatRefusal: a body the API description does not give', () => {
  it('quotes a field it has no name for verbatim, and keeps the body in the fields', async () => {
    const body = { kod: 400, meddelandeTillAnvandare: null, fel: [{ falt: 'summaMoms', text: 'Beloppet saknas' }] }
    const refusal = await readVatRefusal(refused(400, body), 'draft')

    expect(refusal.message).toContain(`Skatteverkets svar: "${JSON.stringify(body)}".`)
    expect(refusal.message).toContain('Det gäller ruta 49 (Moms att betala eller få tillbaka).')
    expect(refusal.message).not.toContain('angav ingen orsak')
    expect(refusal.details.skv_body).toBe(JSON.stringify(body))
  })

  it('quotes a short plain-text body', async () => {
    const refusal = await readVatRefusal(refused(400, 'bad rutor'), 'draft')

    expect(refusal.message).toContain('Skatteverkets svar: "bad rutor".')
    expect(refusal.details.skv_body).toBe('bad rutor')
  })

  it('never prints an error page: it stays in the fields, cut', async () => {
    const page = `<!DOCTYPE html><html><head><title>502</title></head><body>${'x'.repeat(2000)}</body></html>`
    const refusal = await readVatRefusal(refused(502, page), 'draft')

    expect(refusal.message).toBe(
      'Skatteverket tog inte emot utkastet och angav ingen orsak (svarskod 502). ' +
        'Skatteverkets tjänst har ett tekniskt fel just nu. Försök igen om en stund.',
    )
    expect(refusal.details.skv_body).toHaveLength(501)
    expect(refusal.details.skv_body?.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('reads an empty body as no reason given', async () => {
    const refusal = await readVatRefusal(refused(400, ''), 'lock')

    expect(refusal.message).toMatch(/^Skatteverket låste inte utkastet för signering och angav ingen orsak \(svarskod 400\)\./)
    expect(refusal.details).toEqual({ skv_step: 'lock', skv_status: 400 })
  })

  it('reads a response whose body cannot be read at all', async () => {
    const unreadable = { status: 400, text: async () => { throw new Error('stream closed') } } as unknown as Response

    const refusal = await readVatRefusal(unreadable, 'draft')

    expect(refusal.message).toContain('angav ingen orsak (svarskod 400)')
  })
})

describe('readVatRefusal: the findings of the step before', () => {
  const findings = {
    status: 'ERROR' as const,
    resultat: [
      { kod: '49', status: 'ERROR' as const, beskrivning: 'Det måste finnas ett belopp i fält 49.' },
      { kod: 'FK004', status: 'ERROR' as const, beskrivning: 'Belopp saknas för momspliktiga inköp' },
      { kod: '10', status: 'WARNING' as const, beskrivning: 'Ovanligt belopp' },
    ],
  }

  it('names the saved draft\'s ERROR findings when the lock is refused without a reason', async () => {
    const refusal = await readVatRefusal(refused(400, { kod: 400, meddelandeTillAnvandare: null }), 'lock', {
      kontrollresultat: findings,
    })

    expect(refusal.message).toBe(
      'Skatteverket låste inte utkastet för signering. ' +
        'Skatteverkets kontroll visade 2 fel: ruta 49 (Moms att betala eller få tillbaka): Det måste finnas ett belopp i fält 49; ' +
        'FK004: Belopp saknas för momspliktiga inköp. ' +
        `Försök igen om en stund. ${E_SERVICE}`,
    )
  })

  it('prefers the findings the refused answer carries itself', async () => {
    const own = { status: 'ERROR', resultat: [{ kod: '05', status: 'ERROR', beskrivning: 'Beloppet är negativt' }] }
    const refusal = await readVatRefusal(refused(400, { kod: 400, kontrollResultat: own }), 'draft', {
      kontrollresultat: findings,
    })

    expect(refusal.message).toContain('Skatteverkets kontroll visade 1 fel: ruta 05 (Momspliktig försäljning): Beloppet är negativt.')
    expect(refusal.message).not.toContain('FK004')
    expect(refusal.details.skv_body).toBeUndefined()
  })
})

describe('describeKontrollErrors', () => {
  it('is null without ERROR findings', () => {
    expect(describeKontrollErrors(null)).toBeNull()
    expect(describeKontrollErrors({ status: 'OK', resultat: [] })).toBeNull()
    expect(describeKontrollErrors({ resultat: [{ kod: '10', status: 'WARNING', beskrivning: 'Ovanligt belopp' }] })).toBeNull()
  })

  it('spells out five findings and counts the rest', () => {
    const resultat = Array.from({ length: 7 }, (_, i) => ({ kod: `K${i}`, status: 'ERROR', beskrivning: `Fel ${i}` }))

    expect(describeKontrollErrors({ resultat })).toBe(
      'Skatteverkets kontroll visade 7 fel: K0: Fel 0; K1: Fel 1; K2: Fel 2; K3: Fel 3; K4: Fel 4 (och 2 till).',
    )
  })
})
