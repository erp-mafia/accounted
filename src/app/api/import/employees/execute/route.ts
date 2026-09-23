import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import {
  CreateEmployeeSchema,
  EmployeeImportExecuteSchema,
  OpeningBalancesFieldsSchema,
} from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import { EMPLOYEE_FIELD_LABELS } from '@/lib/import/employees/labels'
import { loadExistingEmployeeIndex } from '@/lib/import/employees/existing'
import { createEmployee } from '@/lib/salary/employee-commands'
import { setOpeningBalancesBulk, type OpeningBalancesInput } from '@/lib/salary/opening-balances'
import { encryptPersonnummer, extractLast4, validatePersonnummer } from '@/lib/salary/personnummer'
import type { EmployeeImportExecuteResult } from '@/lib/import/employees/types'

ensureInitialized()

function issueText(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const label = EMPLOYEE_FIELD_LABELS[String(issue.path[0] ?? '')]
      return label ? `${label}: ${issue.message}` : issue.message
    })
    .join('. ')
}

function rowName(employee: Record<string, unknown>): string {
  return `${employee.first_name ?? ''} ${employee.last_name ?? ''}`.trim() || '(namnlös rad)'
}

/**
 * POST /api/import/employees/execute
 *
 * Creates one employee per row through createEmployee() (the same command
 * the MCP executor uses: EF owner rule, bank checksum, jämkning invariant),
 * then writes the cutover blocks through setOpeningBalancesBulk(). Rows that
 * match an existing personnummer are skipped; there is no update mode.
 * Every row is validated on its own so a bad row fails alone.
 */
export const POST = withRouteContext(
  'register_import.employees.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, EmployeeImportExecuteSchema, {
      log,
      operation: 'register_import.employees.execute',
    })
    if (!validation.success) return validation.response

    const { rows } = validation.data
    const opLog = log.child({ rowCount: rows.length })

    try {
      const existing = await loadExistingEmployeeIndex(supabase, companyId)

      let created = 0
      let skipped = 0
      const errors: EmployeeImportExecuteResult['errors'] = []
      const openingItems: Array<OpeningBalancesInput & { row_index: number; name: string }> = []

      for (const row of rows) {
        const name = rowName(row.employee)

        const parsed = CreateEmployeeSchema.safeParse(row.employee)
        if (!parsed.success) {
          errors.push({ row_index: row.row_index, name, reason: issueText(parsed.error.issues) })
          continue
        }
        const employee = parsed.data

        const pnr = validatePersonnummer(employee.personnummer)
        if (!pnr.valid) {
          errors.push({ row_index: row.row_index, name, reason: `Personnummer: ${pnr.error}` })
          continue
        }

        let opening: OpeningBalancesInput | null = null
        if (row.opening_balances) {
          const obParsed = OpeningBalancesFieldsSchema.safeParse(row.opening_balances)
          if (!obParsed.success) {
            errors.push({ row_index: row.row_index, name, reason: issueText(obParsed.error.issues) })
            continue
          }
          opening = { employee_id: '', ...obParsed.data }
        }

        if (existing.has(employee.personnummer)) {
          skipped++
          continue
        }

        const { personnummer, ...fields } = employee
        const result = await createEmployee(supabase, {
          companyId,
          userId: user.id,
          input: {
            ...fields,
            personnummer_encrypted: encryptPersonnummer(personnummer),
            personnummer_last4: extractLast4(personnummer),
          },
        })

        if (!result.ok) {
          if (result.code === 'EMPLOYEE_DUPLICATE_PERSONNUMMER') {
            skipped++
            continue
          }
          const detail = result.details as { message?: string; issues?: { message: string }[] } | undefined
          const reason =
            detail?.message ??
            detail?.issues?.map((i) => i.message).join('. ') ??
            result.code
          errors.push({ row_index: row.row_index, name, reason })
          continue
        }

        created++
        existing.set(personnummer, {
          employee_id: result.data.employee_id,
          existing_name: name,
          is_active: true,
        })
        if (opening) {
          openingItems.push({
            ...opening,
            employee_id: result.data.employee_id,
            row_index: row.row_index,
            name,
          })
        }
      }

      const warnings: string[] = []
      const notices: ImportNotice[] = []
      let openingBalancesSet = 0

      if (openingItems.length > 0) {
        const items: OpeningBalancesInput[] = openingItems.map(
          ({ row_index: _r, name: _n, ...item }) => item,
        )
        const obResult = await setOpeningBalancesBulk(supabase, {
          companyId,
          userId: user.id,
          items,
        })
        if (obResult.ok) {
          openingBalancesSet = obResult.data.count
          warnings.push(`Ingående saldon sparades för ${openingBalancesSet} anställda.`)
          notices.push(makeNotice('employees_opening_balances_set', 'info', { count: openingBalancesSet }))
        } else {
          // Atomic: nothing was written. The employees exist; the balances
          // must be entered on each employee page, so say so per row.
          const itemErrors = obResult.itemErrors ?? []
          for (const item of openingItems) {
            const own = itemErrors.find((e) => e.employee_id === item.employee_id)
            errors.push({
              row_index: item.row_index,
              name: item.name,
              reason: `Anställd skapad, men ingående saldon kunde inte sparas: ${own?.message ?? obResult.code}`,
            })
          }
          warnings.push(`Ingående saldon kunde inte sparas för ${openingItems.length} anställda.`)
          notices.push(
            makeNotice('employees_opening_balances_failed', 'action', { count: openingItems.length }),
          )
        }
      }

      const response: EmployeeImportExecuteResult = {
        success: errors.length === 0,
        created,
        updated: 0,
        skipped,
        failed: errors.length,
        errors,
        opening_balances_set: openingBalancesSet,
        warnings,
        notices,
      }

      opLog.info('employee import complete', {
        created,
        skipped,
        failed: errors.length,
        openingBalancesSet,
      })

      return NextResponse.json({ data: response })
    } catch (err) {
      opLog.error('employee import execute failed', err as Error)
      return errorResponseFromCode('REG_IMPORT_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
