import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Ink3FieldTable } from './field-table'
import { INK3_DERIVED_CODES, INK3_EXCLUSIVE_PAIRS } from './layout'
import { INK3_TREATMENTS, type Ink3FieldValue, type Ink3Inputs, type Ink3Treatment } from './types'

/**
 * What the company enters for one räkenskapsår's INK3 underlag, stored in
 * ink3_underlag_inputs (one row per company and räkenskapsår): the
 * allmännyttig statement, the per-account treatment and the per-ruta
 * overrides. The table's CHECKs hold the shape; the field-level rules
 * (which codes exist, their value sets) depend on the period's pinned field
 * table and are checked here before a save.
 */

const MAX_AMOUNT = 999_999_999_999

/** Result accounts (BAS classes 3-8) only: the taxable column covers income and costs. */
const RESULT_ACCOUNT = /^[3-8]\d{3}$/
const FIELD_CODE = /^\d{4}$/

export const Ink3InputsBodySchema = z
  .object({
    allmannyttig: z.boolean().nullable(),
    account_treatments: z
      .record(z.string().regex(RESULT_ACCOUNT, 'Kontot ska vara ett resultatkonto (3000-8999).'), z.enum(INK3_TREATMENTS))
      .refine((value) => Object.keys(value).length <= 2000, 'Högst 2000 konton.'),
    field_overrides: z
      .record(
        z.string().regex(FIELD_CODE, 'Fältkoden ska vara fyra siffror.'),
        z.union([z.number().int().min(-MAX_AMOUNT).max(MAX_AMOUNT), z.boolean(), z.string().max(36)]),
      )
      .refine((value) => Object.keys(value).length <= 300, 'Högst 300 fält.'),
  })
  .strict()

export type Ink3InputsBody = z.infer<typeof Ink3InputsBodySchema>

export const EMPTY_INK3_INPUTS: Ink3Inputs = { allmannyttig: null, accountTreatments: {}, fieldOverrides: {} }

/** One problem with a field override, against the period's field table. */
export interface Ink3OverrideIssue {
  code: string
  message: string
}

/**
 * Field-level rules the table's CHECKs cannot know: the code exists for the
 * period, it is not a sum, the value fits the field's value set (Vardeforrad),
 * and at most one of a yes/no pair is ticked.
 */
export function validateInk3Overrides(
  table: Ink3FieldTable,
  overrides: Record<string, Ink3FieldValue>,
): Ink3OverrideIssue[] {
  const issues: Ink3OverrideIssue[] = []
  for (const [code, value] of Object.entries(overrides)) {
    const field = table.byCode.get(code)
    if (!field) {
      issues.push({ code, message: `Fältkod ${code} finns inte på INK3 för ${table.beskattningsperiod}.` })
      continue
    }
    if (INK3_DERIVED_CODES.has(code)) {
      issues.push({ code, message: `Fältkod ${code} är en summa och räknas fram ur de andra rutorna.` })
      continue
    }
    switch (field.datatyp) {
      case 'Str_X':
        if (typeof value !== 'boolean') issues.push({ code, message: `Fältkod ${code} är en kryssruta.` })
        break
      case 'Str_36':
        if (typeof value !== 'string' || value.trim().length === 0 || value.length > 36) {
          issues.push({ code, message: `Fältkod ${code} tar en text på 1-36 tecken.` })
        }
        break
      case 'Numeriskt_N':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
          issues.push({ code, message: `Fältkod ${code} tar ett heltal 0-100.` })
        }
        break
      case 'Numeriskt_B':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          issues.push({ code, message: `Fältkod ${code} tar ett belopp i hela kronor som inte är negativt.` })
        }
        break
      case 'Numeriskt_A':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          issues.push({ code, message: `Fältkod ${code} tar ett belopp i hela kronor.` })
        }
        break
    }
  }
  for (const [a, b] of INK3_EXCLUSIVE_PAIRS) {
    if (overrides[a] === true && overrides[b] === true) {
      issues.push({ code: b, message: `Fältkod ${a} och ${b} kan inte båda vara ikryssade.` })
    }
  }
  return issues
}

interface InputsRow {
  allmannyttig: boolean | null
  account_treatments: unknown
  field_overrides: unknown
}

function parseRow(row: InputsRow | null): Ink3Inputs {
  if (!row) return EMPTY_INK3_INPUTS
  const treatments: Record<string, Ink3Treatment> = {}
  if (row.account_treatments && typeof row.account_treatments === 'object') {
    for (const [account, treatment] of Object.entries(row.account_treatments as Record<string, unknown>)) {
      if (RESULT_ACCOUNT.test(account) && (INK3_TREATMENTS as readonly unknown[]).includes(treatment)) {
        treatments[account] = treatment as Ink3Treatment
      }
    }
  }
  const overrides: Record<string, Ink3FieldValue> = {}
  if (row.field_overrides && typeof row.field_overrides === 'object') {
    for (const [code, value] of Object.entries(row.field_overrides as Record<string, unknown>)) {
      if (FIELD_CODE.test(code) && (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')) {
        overrides[code] = value
      }
    }
  }
  return { allmannyttig: row.allmannyttig ?? null, accountTreatments: treatments, fieldOverrides: overrides }
}

/** The company's inputs for the räkenskapsår; the empty set when nothing is saved yet. */
export async function loadInk3Inputs(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<Ink3Inputs> {
  const { data, error } = await supabase
    .from('ink3_underlag_inputs')
    .select('allmannyttig, account_treatments, field_overrides')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load INK3 inputs: ${error.message}`)
  return parseRow(data as InputsRow | null)
}

/** Replace the räkenskapsår's inputs with `body`, in the caller's name. */
export async function saveInk3Inputs(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  body: Ink3InputsBody,
): Promise<Ink3Inputs> {
  const { data, error } = await supabase
    .from('ink3_underlag_inputs')
    .upsert(
      {
        company_id: companyId,
        fiscal_period_id: fiscalPeriodId,
        allmannyttig: body.allmannyttig,
        account_treatments: body.account_treatments,
        field_overrides: body.field_overrides,
        updated_by: userId,
      },
      { onConflict: 'company_id,fiscal_period_id' },
    )
    .select('allmannyttig, account_treatments, field_overrides')
    .single()
  if (error) throw error
  return parseRow(data as InputsRow)
}
