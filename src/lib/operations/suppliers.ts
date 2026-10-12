/**
 * Supplier register (leverantörsregister) operations: create and update. List,
 * get and archive stay the hand-written v1 routes and MCP tools they were. The
 * rules live in lib/suppliers/create-supplier.ts and update-supplier.ts,
 * shared with the dashboard's POST /api/suppliers and PUT /api/suppliers/:id
 * and with the approval of a staged gnubok_create_supplier.
 *
 * suppliers.create keeps the v1 POST contract it replaced (path, body,
 * Idempotency-Key, dry run, 201). The MCP gnubok_create_supplier stays the
 * hand-written tool, validating with the same CreateSupplierSchema.
 *
 * suppliers.update keeps the v1 PATCH contract it replaced (path, body,
 * Idempotency-Key, dry run, archived rule) and adds the MCP door
 * gnubok_update_supplier, which agents migrating a register lacked: the only
 * way to fill in an imported supplier's address or bank details over MCP was
 * a duplicate gnubok_create_supplier (crm#1060).
 */
import { z } from 'zod'
import { CreateSupplierSchema, UpdateSupplierSchema } from '@/lib/api/schemas'
import { createSupplier } from '@/lib/suppliers/create-supplier'
import { SupplierRecordSchema, updateSupplier } from '@/lib/suppliers/update-supplier'
import { defineOperation } from './types'

const SUPPLIER_EXAMPLE = {
  id: '0e9c…',
  name: 'Office Depot AB',
  supplier_type: 'swedish_business',
  email: 'invoices@officedepot.example',
  phone: null,
  address_line1: 'Box 123',
  address_line2: null,
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'SE',
  org_number: '5566778899',
  vat_number: 'SE556677889901',
  bankgiro: '123-4567',
  plusgiro: null,
  bank_account: null,
  clearing_number: null,
  account_number: null,
  iban: null,
  bic: null,
  default_expense_account: '5410',
  default_payment_terms: 14,
  default_currency: 'SEK',
  notes: 'New payment terms agreed 2026-05-12.',
  party_id: null,
  archived_at: null,
  created_at: '2026-04-12T08:30:00Z',
  updated_at: '2026-05-12T09:00:00Z',
}

export const suppliersCreate = defineOperation({
  id: 'suppliers.create',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Create a supplier.',
    description:
      'Creates a new supplier for the company. Bankgiro (with its Luhn check digit), plusgiro, IBAN and BIC are format-checked, since payment files read them. Omitted supplier_type is swedish_business. Requires Idempotency-Key (UUID). Supports ?dry_run=true: the dry run answers the would-be record without id and timestamps.',
    useWhen:
      'You need to register a new supplier before booking supplier invoices against them. Use dry-run first to catch validation errors before committing.',
    doNotUseFor:
      'Updating an existing supplier (PATCH instead). Creating customers (different resource).',
    pitfalls: [
      'Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.',
      'org_number uniqueness is enforced at the database level; duplicate inserts return 409 SUPPLIER_DUPLICATE_ORG_NUMBER.',
      'A Swedish-shaped org_number is stored as the 10-digit key; a foreign registration number is stored as sent.',
      'Unlike customers, suppliers carry no `vat_number_validated` flag: vat_number is stored as supplied without VIES verification. Validate externally if your workflow requires it.',
      'default_expense_account is a BAS account number (e.g. "5410"); the value is stored as-is and used as the suggested debit account when supplier invoices are booked.',
    ],
    example: {
      request: {
        name: 'Office Depot AB',
        supplier_type: 'swedish_business',
        email: 'invoices@officedepot.example',
        org_number: '556677-8899',
        bankgiro: '123-4567',
        default_expense_account: '5410',
        default_payment_terms: 30,
        default_currency: 'SEK',
      },
      response: {
        data: { ...SUPPLIER_EXAMPLE, notes: null, updated_at: '2026-04-12T08:30:00Z' },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: CreateSupplierSchema,
  output: SupplierRecordSchema,
  errorCodes: ['SUPPLIER_DUPLICATE_ORG_NUMBER', 'SUPPLIER_CREATE_FAILED', 'VALIDATION_ERROR'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/suppliers',
  },
  run: (ctx, input, { dryRun }) => createSupplier(ctx, input, { dryRun }),
})

export const suppliersUpdate = defineOperation({
  id: 'suppliers.update',
  kind: 'write',
  scope: 'suppliers:write',
  // Medium although nothing is booked: bank details decide where future
  // payment files send money (same BEC rationale as create_supplier).
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Partially update a supplier.',
    description:
      'Patches the supplier with the fields sent; every field is optional and the rest stay as they are. An empty string clears a text field (null for email and default_expense_account). archived_at: null un-archives a supplier archived with DELETE. An archived supplier\'s identifying fields (name, type, org and VAT number, address, bank details) are räkenskapsinformation and cannot change until it is un-archived. The dry run answers the would-be supplier with `changes` (each changed field, from and to) and `payment_details_changed`. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
    useWhen:
      'A supplier needs other contact details, address, payment details (bankgiro, plusgiro, clearing and account number, IBAN, BIC), VAT number, default expense account, payment terms or notes, e.g. a supplier imported from SIE with only a name and a bankgiro. Dry-run first to confirm the change.',
    doNotUseFor:
      'Archiving a supplier (DELETE sets archived_at). Creating one (POST /suppliers). Merging duplicates: there is no merge; archive the duplicate once its invoices are closed.',
    pitfalls: [
      'Idempotency-Key is mandatory; calls without it return 400.',
      'An empty body returns 400 VALIDATION_ERROR.',
      'org_number uniqueness is enforced at DB level: 409 SUPPLIER_DUPLICATE_ORG_NUMBER.',
      'An archived supplier refuses a change to an identifying field with 400 VALIDATION_ERROR (details.field archived_at, details.offending_fields); send archived_at: null first.',
      'Changing default_expense_account does not rebook earlier supplier invoices: only future bookings pick up the new default.',
      'A Swedish bank account payee is clearing_number + account_number; bank_account is free text that payment files only read with an explicit clearing number.',
    ],
    example: {
      request: { default_payment_terms: 14, notes: 'New payment terms agreed 2026-05-12.' },
      response: { data: SUPPLIER_EXAMPLE, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
    },
  },
  input: UpdateSupplierSchema.extend({
    supplier_id: z.string().uuid().describe('The supplier to change (gnubok_list_suppliers).'),
    // Only null: a caller may un-archive, never fake an archive timestamp.
    archived_at: z.null().optional().describe('null un-archives an archived supplier.'),
  }),
  output: SupplierRecordSchema,
  errorCodes: ['SUPPLIER_NOT_FOUND', 'SUPPLIER_DUPLICATE_ORG_NUMBER', 'VALIDATION_ERROR'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/suppliers/:id',
    pathParams: { id: 'supplier_id' },
  },
  mcp: {
    name: 'gnubok_update_supplier',
    title: 'Update Supplier (Leverantör)',
    description:
      'Stage a partial edit of a supplier: contact, address, org/VAT number, bankgiro, plusgiro, clearing+account number, IBAN/BIC, default account, payment terms, notes. "" clears; archived_at null un-archives. supplier_id from gnubok_list_suppliers.',
    keywords: [
      'ändra leverantör',
      'uppdatera leverantör',
      'leverantörsregister',
      'leverantörens adress',
      'leverantörens bankgiro',
      'återställ leverantör',
      'update supplier',
      'edit supplier',
    ],
    stage: {
      pendingType: 'update_supplier',
      title: (input, preview) => {
        const changes = (preview?.changes ?? {}) as Record<string, { from?: unknown }>
        const name = changes.name?.from ?? preview?.name ?? input.name ?? ''
        return `Uppdatera leverantör: ${String(name)}`.trim()
      },
    },
  },
  run: (ctx, { supplier_id, ...changes }, { dryRun }) => updateSupplier(ctx, supplier_id, changes, { dryRun }),
})
