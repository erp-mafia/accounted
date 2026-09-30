import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getStructuredError } from '../get-structured-error'
import { getErrorEntry } from '../structured-errors'
import { codedRefusal, fieldValidationError, serviceRefusal, zodErrorFieldIssues, zodFieldIssues } from '../refusal'

describe('codedRefusal', () => {
  it('keeps the code, takes message_en from the thrown text and message_sv from the registry', () => {
    const s = getStructuredError(codedRefusal('SALARY_RUN_NOT_FOUND', 'Salary run not found: no run with id run-x in this company.'))
    expect(s).toMatchObject({
      code: 'SALARY_RUN_NOT_FOUND',
      message_sv: 'Lönekörningen kunde inte hittas.',
      message_en: 'Salary run not found: no run with id run-x in this company.',
      retryable: false,
    })
  })

  it('lets a hint from the throw site win over the registry remediation', () => {
    const s = getStructuredError(
      codedRefusal('SALARY_RUN_NOT_FOUND', 'No salary run for 2026-02 in this company.', {
        description: 'Create it.',
        tool: 'gnubok_create_salary_run',
        args: { period_year: 2026, period_month: 2 },
      }),
    )
    expect(s.remediation).toEqual({
      description: 'Create it.',
      tool: 'gnubok_create_salary_run',
      args: { period_year: 2026, period_month: 2 },
    })
  })
})

describe('fieldValidationError', () => {
  const issues = Array.from({ length: 5 }, (_, i) => ({ field: `f${i}`, en: `bad ${i}`, sv: `Fel ${i}.` }))

  it('is a non-retryable VALIDATION_ERROR naming the fields in both languages', () => {
    const s = getStructuredError(fieldValidationError('Invalid employee', issues.slice(0, 1)))
    expect(s).toMatchObject({
      code: 'VALIDATION_ERROR',
      message_en: 'Invalid employee: f0: bad 0',
      message_sv: 'f0: Fel 0.',
      retryable: false,
    })
  })

  it('spells out three issues and counts the rest', () => {
    const s = getStructuredError(fieldValidationError('Invalid employee', issues))
    expect(s.message_en).toBe('Invalid employee: f0: bad 0; f1: bad 1; f2: bad 2 (+2 more)')
    expect(s.message_sv).toBe('f0: Fel 0. f1: Fel 1. f2: Fel 2. (+2 till)')
  })
})

describe('zodFieldIssues', () => {
  const schema = z.object({
    days: z.number().int().min(25).max(40),
    rate: z.number().positive(),
    name: z.string().min(1).max(5),
    rows: z.array(z.string()).min(1),
    kind: z.enum(['monthly', 'hourly']),
    email: z.string().email(),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
    pnr: z.string().regex(/^\d{12}$/, 'Personnummer måste vara 12 siffror (ÅÅÅÅMMDDNNNN)'),
    nested: z.object({ year: z.number() }),
  }).superRefine((data, ctx) => {
    if (data.days === 30) ctx.addIssue({ code: 'custom', message: 'Trettio dagar är inte tillåtet här', path: ['days'] })
  })

  function reasons(input: Record<string, unknown>): Record<string, string> {
    const parsed = schema.safeParse(input)
    if (parsed.success) throw new Error('expected a failure')
    return Object.fromEntries(zodFieldIssues(parsed.error, input).map((i) => [i.field, i.sv]))
  }

  const valid = {
    days: 25, rate: 1, name: 'Anna', rows: ['a'], kind: 'monthly', email: 'a@b.se',
    start: '2026-01-01', pnr: '190001010000', nested: { year: 2026 },
  }

  it('renders bounds in Swedish', () => {
    expect(reasons({ ...valid, days: 20, rate: 0, name: 'Annabel', rows: [] })).toMatchObject({
      days: 'Måste vara minst 25.',
      rate: 'Måste vara större än 0.',
      name: 'Högst 5 tecken.',
      rows: 'Minst en rad.',
    })
    expect(reasons({ ...valid, days: 41, name: '' })).toMatchObject({
      days: 'Får vara högst 40.',
      name: 'Får inte vara tomt.',
    })
  })

  it('tells a missing field from a wrong type and from null', () => {
    expect(reasons({ ...valid, days: undefined, rate: 'x', name: null, nested: {} })).toMatchObject({
      days: 'Obligatoriskt fält saknas.',
      rate: 'Fel typ: ska vara ett tal.',
      name: 'Fältet kan inte tömmas (null är inte tillåtet).',
      'nested.year': 'Obligatoriskt fält saknas.',
    })
    expect(reasons({ ...valid, days: 25.5 })).toMatchObject({ days: 'Fel typ: ska vara ett heltal.' })
  })

  it('renders enum, email and the shared ISO date message, and keeps the schema\'s own Swedish', () => {
    expect(reasons({ ...valid, kind: 'weekly', email: 'nope', start: '01/01/2026', pnr: '123' })).toMatchObject({
      kind: 'Måste vara ett av: monthly, hourly.',
      email: 'Ogiltig e-postadress.',
      start: 'Ogiltigt datumformat (YYYY-MM-DD)',
      pnr: 'Personnummer måste vara 12 siffror (ÅÅÅÅMMDDNNNN)',
    })
    expect(reasons({ ...valid, days: 30 })).toMatchObject({ days: 'Trettio dagar är inte tillåtet här' })
  })

  it('keeps Zod\'s own English for message_en', () => {
    const input = { ...valid, days: 20 }
    const parsed = schema.safeParse(input)
    if (parsed.success) throw new Error('expected a failure')
    expect(zodFieldIssues(parsed.error, input)[0]).toMatchObject({ field: 'days', en: expect.stringMatching(/>=25/) })
  })

  it('without the input (zodErrorFieldIssues) gives the same reasons, read from what Zod says it received', () => {
    const input = { ...valid, days: undefined, rate: 'x', name: null, nested: {}, kind: 'weekly' }
    const parsed = schema.safeParse(input)
    if (parsed.success) throw new Error('expected a failure')
    expect(zodErrorFieldIssues(parsed.error)).toEqual(zodFieldIssues(parsed.error, input))
  })
})

describe('serviceRefusal', () => {
  it('keeps a service code and names the run status it saw', () => {
    const s = getStructuredError(
      serviceRefusal('Cannot update payslip line', { code: 'SALARY_RUN_LINE_NOT_DRAFT', details: { current_status: 'booked' } }),
    )
    expect(s.code).toBe('SALARY_RUN_LINE_NOT_DRAFT')
    expect(s.message_en).toBe(
      `Cannot update payslip line: SALARY_RUN_LINE_NOT_DRAFT. ${getErrorEntry('SALARY_RUN_LINE_NOT_DRAFT')!.message_en} Current status: booked.`,
    )
    expect(s.message_sv).toBe(getErrorEntry('SALARY_RUN_LINE_NOT_DRAFT')!.message_sv)
    expect(s.retryable).toBe(false)
  })

  it('turns a VALIDATION_ERROR on a named field into a field refusal', () => {
    const s = getStructuredError(
      serviceRefusal('Cannot update payslip line', {
        code: 'VALIDATION_ERROR',
        details: { field: 'vacation_category', message: 'Semesterkategori gäller bara semesterrader.' },
      }),
    )
    expect(s).toMatchObject({
      code: 'VALIDATION_ERROR',
      message_en: 'Cannot update payslip line: vacation_category: Semesterkategori gäller bara semesterrader.',
      message_sv: 'vacation_category: Semesterkategori gäller bara semesterrader.',
    })
  })

  it('carries the database message so a timeout behind INTERNAL_ERROR stays retryable', () => {
    const s = getStructuredError(
      serviceRefusal('Cannot update payslip line', {
        code: 'INTERNAL_ERROR',
        details: { message: 'canceling statement due to statement timeout' },
      }),
    )
    expect(s.code).toBe('INTERNAL_ERROR')
    expect(s.retryable).toBe(true)
  })
})
