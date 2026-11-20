/**
 * Changed supplier bank details through the MCP door (lib/payments/
 * payee-alerts.ts): an agent may stage a person's approval of the account an
 * invoice states, never give it. The staged operation is approvable only by
 * a person in the Accounted web UI (WEB_ONLY_APPROVAL_TYPES): confirming an
 * account is what releases money to it, the step invoice fraud needs.
 *
 * No v1 binding: the decision is a person's act in the web UI, like signing.
 * Rejecting is the person's own act there too (POST
 * /api/supplier-invoices/:id/payee).
 */
import { z } from 'zod'
import { decideSupplierPayee } from '@/lib/payments/payee-alerts'
import { defineOperation } from './types'

export const supplierPayeesConfirm = defineOperation({
  id: 'supplier-payees.confirm',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Stage the approval of new bank details a supplier invoice states.',
    description:
      'A supplier invoice that states a bankgiro, plusgiro or account the supplier card does not have is held from payment (payment file ' +
      'and bank payment skip it as payee_unconfirmed) until a person approves the account. This stages that approval: a person approves ' +
      'it in Accounted (Granskning), never an agent. The approval covers later invoices of the supplier with the same account, and by ' +
      'default puts the account on the supplier card.',
    useWhen:
      'gnubok_list_supplier_invoices shows payee_alert changed on an invoice the user wants paid, and the user has checked the new bank ' +
      'details with the supplier on a known channel (not the invoice or its e-mail).',
    doNotUseFor: 'Paying the invoice (gnubok_prepare_payments) or editing the supplier (gnubok_update_supplier).',
    pitfalls: [
      'SUPPLIER_PAYEE_NOTHING_TO_DECIDE: the invoice states no account the supplier card lacks.',
      'Approval happens in Accounted only; gnubok_approve_pending_operation refuses this type.',
      'Changed bank details on an invoice are the classic invoice fraud: never stage this on the invoice\'s own word.',
    ],
    example: {
      request: { supplier_invoice_id: '6f1c2a40-0000-4000-8000-000000000001' },
      response: {
        data: {
          supplier_invoice_id: '6f1c2a40-0000-4000-8000-000000000001',
          supplier_id: '6f1c2a40-0000-4000-8000-000000000002',
          decision: 'confirmed',
          payee: 'BG 9020-0001',
          supplier_card_updated: true,
        },
      },
    },
  },
  input: z.object({
    supplier_invoice_id: z.string().uuid().describe('The supplier invoice whose stated account to approve (supplier_invoice_id).'),
    update_supplier_card: z
      .boolean()
      .optional()
      .describe('Make the account the supplier card\'s payment account (default true).'),
    note: z.string().trim().max(500).optional().describe('How the account was checked, e.g. "called the supplier on 08-123 45 67".'),
  }),
  output: z.object({
    supplier_invoice_id: z.string().uuid(),
    supplier_id: z.string().uuid(),
    decision: z.literal('confirmed'),
    payee: z.string().describe('The approved account, as a label (BG 9020-0001).'),
    supplier_card_updated: z.boolean(),
  }),
  errorCodes: ['SI_NOT_FOUND', 'SUPPLIER_PAYEE_NOTHING_TO_DECIDE', 'SUPPLIER_PAYEE_DECISION_FAILED'],
  mcp: {
    name: 'gnubok_confirm_supplier_payee',
    title: 'Confirm Supplier Bank Details',
    description:
      'Stage the approval of new bank details a supplier invoice states (payee_alert changed). Only a person approves it, in Accounted; ' +
      'until then the invoice is not paid. Check the details with the supplier first: changed details are the classic invoice fraud.',
    visibility: 'search',
    keywords: ['nya bankuppgifter', 'ändrat bankgiro', 'bankgiro', 'betalningsmottagare', 'fakturabedrägeri', 'godkänn konto'],
    stage: {
      pendingType: 'confirm_supplier_payee',
      title: (_input, preview) => {
        const supplier = typeof preview?.supplier_name === 'string' && preview.supplier_name ? preview.supplier_name : null
        const account = typeof preview?.invoice_account === 'string' ? preview.invoice_account : null
        return `Godkänn nya bankuppgifter${supplier ? ` hos ${supplier}` : ''}${account ? `: ${account}` : ''}`
      },
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await decideSupplierPayee(
      ctx,
      {
        supplierInvoiceId: input.supplier_invoice_id,
        decision: 'confirmed',
        updateSupplierCard: input.update_supplier_card,
        note: input.note ?? null,
      },
      { dryRun },
    )
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { ...outcome.data, decision: 'confirmed' as const } }
  },
})
