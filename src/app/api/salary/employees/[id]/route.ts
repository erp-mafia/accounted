import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeSchema } from '@/lib/api/schemas'
import { maskEmployeeForResponse } from '@/lib/salary/personnummer'
import { sealPersonnummer, updateEmployee } from '@/lib/salary/employee-commands'
import { softDeleteEmployee } from '@/lib/salary/employee-soft-delete'
import { employeeCommandErrorResponse } from '@/lib/salary/employee-command-response'

// Response shaping lives in the shared maskEmployeeForResponse: it drops the
// ciphertext AND personnummer_last4 (mask + last4 reassembles the full
// personnummer) and returns the mask under the read-only `personnummer_masked`
// key, never the writable `personnummer` key. This route both reads and writes
// the same object shape, so a mask under the write key would round-trip
// 'ÅÅÅÅMMDD-XXXX' straight into the encrypt path.

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.get',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: employee, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !employee) {
      return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data: maskEmployeeForResponse(employee) })
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, UpdateEmployeeSchema)
    if (!validation.success) return validation.response
    // `personnummer` is taken OUT of the patch and handled on its own: the
    // service never sees a plaintext personnummer, and spreading it would let
    // a falsy-but-present value overwrite the ciphertext.
    const { personnummer: pnrInput, ...patch } = validation.data

    // personnummer semantics on this PATCH (the only door that offers an
    // identity correction; v1 and MCP keep it immutable):
    //   • key absent / undefined → identity unchanged.
    //   • '' or null, or a masked display value → 400 (sealPersonnummer):
    //     there is no "clear the personnummer" operation (NOT NULL, and
    //     AGI/KU filing, Skatteverket FK215, cannot be produced without it).
    //   • 12 digits → validated (format, date range, Luhn) and re-sealed,
    //     refreshing personnummer_last4 in the same update.
    let identity
    if (pnrInput !== undefined) {
      const sealed = sealPersonnummer(pnrInput)
      if (!sealed.ok) return NextResponse.json({ error: sealed.message }, { status: 400 })
      identity = sealed.identity
    }

    // Merged-state rules, the EF-owner rule and the write are
    // lib/salary/employee-commands.ts, the one update every door runs.
    const result = await updateEmployee(supabase, {
      companyId: companyId!,
      employeeId: id,
      patch,
      identity,
      columns: '*',
    })
    if (!result.ok) return employeeCommandErrorResponse(result)

    return NextResponse.json({ data: result.data.row })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.employees.delete',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Soft delete only (BFL 7 kap retention), the rule v1 and MCP share
    // (lib/salary/employee-soft-delete.ts). "Not found" is decided by the
    // read, never by a refused write; a legacy incomplete jämkning beslut
    // answers with what to complete or clear (#2697).
    const result = await softDeleteEmployee(supabase, { companyId: companyId!, employeeId: id })
    if (!result.ok) return employeeCommandErrorResponse(result)

    return NextResponse.json({ data: { id: result.data.employee.id, is_active: false } })
  },
  { requireWrite: true },
)
