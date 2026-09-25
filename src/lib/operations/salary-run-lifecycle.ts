/**
 * Salary-run lifecycle operations that used to be dashboard-only:
 *
 *   salary-runs.send-payslips         email each employee a secure payslip link
 *   salary-runs.revert                review   -> draft
 *   salary-runs.unapprove             approved -> review
 *   salary-runs.attach-expense-claims put open utlägg on a draft payslip
 *
 * The rest of the salary-run lifecycle (create, calculate, approve,
 * mark-paid, book, correct, AGI) stays on its hand-written v1 routes. Rules
 * live in lib/salary/payslips/send.ts, lib/salary/run-status-recall.ts and
 * lib/salary/expense-claim-lines.ts; none of them computes an amount, tax or
 * avgift: they move a run between statuses, email links, or copy a
 * registered claim's amount onto the payslip.
 */
import { z } from 'zod'
import { sendPayslips } from '@/lib/salary/payslips/send'
import { revertSalaryRunToDraft, unapproveSalaryRun } from '@/lib/salary/run-status-recall'
import { attachOpenExpenseClaims } from '@/lib/salary/expense-claim-lines'
import { defineOperation } from './types'

const SALARY_RUN_ID = z.string().uuid().describe('The salary run id (from GET /salary-runs).')
const EMPLOYEE_ID = z.string().uuid().describe('The employee id (employees.id), not the salary_run_employees row id.')

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const RUN_EXAMPLE_ID = 'run_a8f1…'

// ---------------------------------------------------------------------------
// Send payslips
// ---------------------------------------------------------------------------

const PayslipDelivery = z.object({
  employee_id: z.string().uuid(),
  employee_name: z.string(),
  status: z.enum(['sent', 'failed', 'skipped']),
  error: z.string().nullable().describe('Why the send failed or was skipped; null when sent.'),
})

const PayslipsSent = z.object({
  salary_run_id: z.string().uuid(),
  sent: z.number().int(),
  skipped: z.number().int().describe('Employees without an email address (logged as skipped).'),
  failed: z.number().int(),
  total: z.number().int(),
  deliveries: z.array(PayslipDelivery),
})

export const salaryRunsSendPayslips = defineOperation({
  id: 'salary-runs.send-payslips',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Email every employee on an approved salary run a secure link to their payslip.',
    description:
      'Sends each employee on the run an email with a secure link to their lönebesked (never a PDF attachment: salary data and personnummer must not sit in inboxes). Each send rotates the employee\'s link, so a link emailed earlier for the run stops working. Every attempt, sent, failed or skipped for a missing email address, is written to the delivery log (salary_payslip_deliveries, BFL 7 kap.). One employee failing does not stop the others. Requires the run to be approved, paid or booked. Dry-runnable: the dry run lists the recipients and who lacks an email address, and sends nothing.',
    useWhen:
      'The run is approved (or paid/booked) and the employees should get their payslips, or a payslip should be re-sent after an employee\'s email address was corrected.',
    doNotUseFor:
      'Fetching the payslip document yourself (GET /salary-runs/{id}/payslips/{employeeId}/pdf) or reading payslip amounts (GET /salary-runs/{id}/employees/{employeeId}).',
    pitfalls: [
      'A draft or review run returns 400 SALARY_PAYSLIPS_SEND_INVALID_STATUS: approve it first.',
      'Re-sending emails everyone on the run again and invalidates the links sent before.',
      'Employees without an email address are skipped and counted in `skipped`, not an error: fix the address with PATCH /employees/{id} and send again.',
      'Refused with 403 from the sandbox company (SALARY_PAYSLIPS_SEND_SANDBOX) and without the email capability (SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED).',
      'Not idempotent towards the recipients: a replay with a new Idempotency-Key emails everyone again.',
    ],
    example: {
      response: {
        data: {
          salary_run_id: RUN_EXAMPLE_ID,
          sent: 2,
          skipped: 1,
          failed: 0,
          total: 3,
          deliveries: [
            { employee_id: 'emp_1…', employee_name: 'Anna Andersson', status: 'sent', error: null },
            { employee_id: 'emp_2…', employee_name: 'Björn Berg', status: 'skipped', error: 'Anställd saknar e-postadress' },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID }),
  output: PayslipsSent,
  errorCodes: [
    'SALARY_RUN_NOT_FOUND',
    'SALARY_PAYSLIPS_SEND_INVALID_STATUS',
    'SALARY_PAYSLIPS_NO_EMPLOYEES',
    'SALARY_PAYSLIPS_SEND_SANDBOX',
    'SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/salary-runs/:id/send-payslips',
    pathParams: { id: 'salary_run_id' },
  },
  mcp: {
    name: 'gnubok_send_payslips',
    title: 'Send Payslips',
    description:
      'Stage emailing every employee on an approved (or paid/booked) salary run a secure link to their payslip; each send replaces the earlier link. The preview lists recipients and who lacks an email address. Nothing is sent until approved.',
    keywords: ['skicka lönebesked', 'lönespecifikation', 'lönebesked e-post', 'maila lönebesked', 'payslip email'],
    stage: { pendingType: 'send_payslips', title: () => 'Skicka lönebesked' },
  },
  run: async (ctx, { salary_run_id }, { dryRun }) => {
    const outcome = await sendPayslips(ctx, salary_run_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const { sent, skipped, failed, total, deliveries } = outcome.data
    return { ok: true, data: { salary_run_id, sent, skipped, failed, total, deliveries } }
  },
})

// ---------------------------------------------------------------------------
// Revert (review -> draft)
// ---------------------------------------------------------------------------

const RunReverted = z.object({
  salary_run_id: z.string().uuid(),
  status: z.literal('draft'),
})

export const salaryRunsRevert = defineOperation({
  id: 'salary-runs.revert',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Send a salary run in review back to draft so it can be edited.',
    description:
      'Moves the run from `review` to `draft`. Nothing is deleted or booked: the calculated figures stay on the run until it is recalculated, and payslip lines, employees and salaries become editable again. Run POST /salary-runs/{id}/calculate afterwards to get back to review. Idempotent. Dry-runnable.',
    useWhen:
      'A calculated run needs a change before approval: a missing line, an employee added or removed, a corrected salary or absence in the deviation period.',
    doNotUseFor:
      'An approved run (POST /salary-runs/{id}/unapprove first) or a paid or booked run (POST /salary-runs/{id}/correct).',
    pitfalls: [
      'Only a run in `review` can be reverted: anything else returns 400 SALARY_RUN_REVERT_NOT_REVIEW with details.current_status.',
      'A run that moves on between the check and the write returns 409 SALARY_RUN_STATUS_CHANGED: read it again.',
    ],
    example: {
      response: { data: { salary_run_id: RUN_EXAMPLE_ID, status: 'draft' }, meta: META },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID }),
  output: RunReverted,
  errorCodes: ['SALARY_RUN_NOT_FOUND', 'SALARY_RUN_REVERT_NOT_REVIEW', 'SALARY_RUN_STATUS_CHANGED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/salary-runs/:id/revert',
    pathParams: { id: 'salary_run_id' },
  },
  mcp: {
    name: 'gnubok_revert_salary_run',
    title: 'Revert Salary Run To Draft',
    description:
      'Stage sending a salary run in review back to draft so its lines, employees and salaries can be edited; recalculate afterwards. Only for review; an approved run needs gnubok_unapprove_salary_run first.',
    keywords: ['återställ lönekörning', 'tillbaka till utkast', 'lås upp lönekörning', 'ändra lönekörning'],
    stage: { pendingType: 'revert_salary_run', title: () => 'Återställ lönekörning till utkast' },
  },
  run: async (ctx, { salary_run_id }, { dryRun }) => {
    const outcome = await revertSalaryRunToDraft(ctx, salary_run_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { salary_run_id, status: 'draft' as const } }
  },
})

// ---------------------------------------------------------------------------
// Unapprove (approved -> review)
// ---------------------------------------------------------------------------

const RunUnapproved = z.object({
  salary_run_id: z.string().uuid(),
  status: z.literal('review'),
  deleted_agi_declaration_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The generated but unfiled AGI declaration removed as stale, or null.'),
})

export const salaryRunsUnapprove = defineOperation({
  id: 'salary-runs.unapprove',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Recall the approval of a salary run (approved back to review).',
    description:
      'Moves an approved run back to `review` and clears the approver, the AGI generation stamp and the payment-file tracking. A generated or exported AGI declaration that never reached Skatteverket is deleted, because its amounts may change. Refused once the AGI is being signed or has been filed: the period is then changed with a corrected AGI. A paid or booked run is never unapproved; it is corrected. Payslips already emailed are not recalled. Idempotent. Dry-runnable: the dry run names the AGI declaration it would delete, whether a payment file was generated and how many payslips were sent.',
    useWhen:
      'An approved run turns out wrong before it was paid and before the AGI was filed, and must be recalculated.',
    doNotUseFor:
      'A paid or booked run (POST /salary-runs/{id}/correct) or a period whose AGI was filed (file a corrected AGI).',
    pitfalls: [
      'Only an `approved` run: anything else returns 400 SALARY_RUN_UNAPPROVE_NOT_APPROVED.',
      'An AGI in pending_signature, submitted or accepted (or agi_submitted_at set) returns 409 SALARY_RUN_UNAPPROVE_AGI_FILED.',
      'A payment file generated for the run may already be with the bank: the API cannot know. Check before recalling, or salaries may be paid on the old amounts.',
      'To edit the run afterwards, also revert it to draft (POST /salary-runs/{id}/revert).',
    ],
    example: {
      response: {
        data: { salary_run_id: RUN_EXAMPLE_ID, status: 'review', deleted_agi_declaration_id: null },
        meta: META,
      },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID }),
  output: RunUnapproved,
  errorCodes: [
    'SALARY_RUN_NOT_FOUND',
    'SALARY_RUN_UNAPPROVE_NOT_APPROVED',
    'SALARY_RUN_UNAPPROVE_AGI_FILED',
    'SALARY_RUN_STATUS_CHANGED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/salary-runs/:id/unapprove',
    pathParams: { id: 'salary_run_id' },
  },
  mcp: {
    name: 'gnubok_unapprove_salary_run',
    title: 'Unapprove Salary Run',
    description:
      'Stage recalling an approved salary run to review: clears approval and payment-file tracking and deletes an unfiled AGI draft. Refused once the AGI is filed or the run is paid or booked (use the correction flow).',
    keywords: ['återkalla godkännande', 'lås upp godkänd lönekörning', 'ångra godkännande lön'],
    stage: { pendingType: 'unapprove_salary_run', title: () => 'Återkalla godkännandet av lönekörningen' },
  },
  run: async (ctx, { salary_run_id }, { dryRun }) => {
    const outcome = await unapproveSalaryRun(ctx, salary_run_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: {
        salary_run_id,
        status: 'review' as const,
        deleted_agi_declaration_id: outcome.data.deletedAgiDeclarationId,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Attach open expense claims to a payslip
// ---------------------------------------------------------------------------

const ExpenseClaimLine = z.object({
  salary_line_id: z.string().uuid(),
  expense_claim_id: z.string().uuid(),
  description: z.string(),
  amount: z.number(),
  account_number: z.string().nullable().describe('The claim\'s liability account (e.g. "2820"), as a string.'),
})

const ExpenseClaimsAttached = z.object({
  salary_run_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  claim_count: z.number().int(),
  total_sek: z.number(),
  lines: z.array(ExpenseClaimLine),
})

export const salaryRunsAttachExpenseClaims = defineOperation({
  id: 'salary-runs.attach-expense-claims',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Repay an employee\'s open expense claims (utlägg) with this salary run.',
    description:
      'Adds one tax-free expense_reimbursement line to the employee\'s payslip on a draft run for every registered expense claim of theirs that is not already on a payslip. The amount and liability account are copied from each claim (the server resolves them; nothing about amounts is sent). The lines raise the net payout only: no tax, no arbetsgivaravgifter, outside the AGI. Booking the run debits the liability account and marks exactly these claims paid. Recalculate the run afterwards. Dry-runnable: the dry run lists the claims that would be added.',
    useWhen:
      'The employee paid a business expense privately, the claim is registered, and it should be repaid with the salary instead of a separate bank transfer.',
    doNotUseFor:
      'Registering the expense claim itself (the expense-claims flow books it), taxable allowances (add a payslip line), or repaying by bank transfer.',
    pitfalls: [
      'Draft runs only: a run past draft returns 400 SALARY_RUN_LINE_NOT_DRAFT (revert it first).',
      'The employee must be on the run: otherwise 404 SALARY_RUN_EMPLOYEE_NOT_FOUND.',
      'No open claims returns 404 SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS; a claim that lands on another payslip concurrently returns 409 EXPENSE_CLAIM_ALREADY_ON_PAYSLIP.',
      'Adds all open claims of the employee at once; remove a line you do not want with DELETE /salary-runs/{id}/lines/{lineId}.',
      'Run POST /salary-runs/{id}/calculate afterwards so the totals include the lines.',
    ],
    example: {
      response: {
        data: {
          salary_run_id: RUN_EXAMPLE_ID,
          employee_id: 'emp_1…',
          claim_count: 1,
          total_sek: 450,
          lines: [
            {
              salary_line_id: 'line_1…',
              expense_claim_id: 'claim_1…',
              description: 'Utlägg: Tågbiljett (2026-09-03)',
              amount: 450,
              account_number: '2820',
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID, employee_id: EMPLOYEE_ID }),
  output: ExpenseClaimsAttached,
  errorCodes: [
    'SALARY_RUN_NOT_FOUND',
    'SALARY_RUN_LINE_NOT_DRAFT',
    'SALARY_RUN_EMPLOYEE_NOT_FOUND',
    'SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS',
    'EXPENSE_CLAIM_ALREADY_ON_PAYSLIP',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/salary-runs/:id/employees/:employeeId/expense-claims',
    pathParams: { id: 'salary_run_id', employeeId: 'employee_id' },
  },
  mcp: {
    name: 'gnubok_attach_salary_expense_claims',
    title: 'Attach Expense Claims To Payslip',
    description:
      'Stage putting an employee\'s open registered expense claims (utlägg) on their payslip in a draft salary run as tax-free reimbursement lines; amounts come from the claims. Recalculate the run afterwards.',
    keywords: ['utlägg på lön', 'betala ut utlägg via lön', 'utlägg lönebesked', 'kostnadsersättning utlägg'],
    stage: { pendingType: 'attach_salary_expense_claims', title: () => 'Lägg utlägg på lönebeskedet' },
  },
  run: async (ctx, { salary_run_id, employee_id }, { dryRun }) => {
    const outcome = await attachOpenExpenseClaims(ctx, { salaryRunId: salary_run_id, employeeId: employee_id }, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const { claim_count, total_sek, lines } = outcome.data
    return {
      ok: true,
      created: true,
      data: {
        salary_run_id,
        employee_id,
        claim_count,
        total_sek,
        lines: lines.map((line) => ({
          salary_line_id: line.id,
          expense_claim_id: line.source_expense_claim_id as string,
          description: line.description,
          amount: line.amount,
          account_number: line.account_number,
        })),
      },
    }
  },
})
