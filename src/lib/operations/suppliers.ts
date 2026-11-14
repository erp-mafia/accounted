/**
 * Supplier register (leverantörsregister) operations: create, update and
 * archive. List and get stay the hand-written v1 routes and MCP tools they
 * were. The rules live in lib/suppliers/create-supplier.ts and
 * update-supplier.ts, shared with the dashboard's POST /api/suppliers and
 * PUT /api/suppliers/:id and with the approval of a staged
 * gnubok_create_supplier.
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
 *
 * suppliers.archive is the MCP door gnubok_archive_supplier on the rule the
 * v1 DELETE /suppliers/:id already had (lib/suppliers/archive-supplier.ts):
 * an agent that found a duplicate supplier after an import could not set it
 * aside (crm#1796). It has no http binding: the v1 DELETE keeps its
 * hand-written route and 204 contract and calls the same service.
 */
import { z } from 'zod'
import { CreateSupplierSchema, UpdateSupplierSchema } from '@/lib/api/schemas'
import { archiveSupplier } from '@/lib/suppliers/archive-supplier'
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
  default_dimensions: { '1': 'KS01' },
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
      'default_dimensions ({"<sie_dim_no>":"<code>"}, codes from GET /dimensions) tags every new supplier invoice of the supplier that sends no default_dimensions of its own; with dimensions enabled an unknown or archived code returns 400 DIMENSION_VALIDATION_FAILED.',
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
  errorCodes: ['SUPPLIER_DUPLICATE_ORG_NUMBER', 'SUPPLIER_CREATE_FAILED', 'VALIDATION_ERROR', 'DIMENSION_VALIDATION_FAILED'],
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
      'A supplier needs other contact details, address, payment details (bankgiro, plusgiro, clearing and account number, IBAN, BIC), VAT number, default expense account, default dimensions, payment terms or notes, e.g. a supplier imported from SIE with only a name and a bankgiro. Dry-run first to confirm the change.',
    doNotUseFor:
      'Archiving a supplier (DELETE sets archived_at). Creating one (POST /suppliers). Merging duplicates: there is no merge; archive the duplicate once its invoices are closed.',
    pitfalls: [
      'Idempotency-Key is mandatory; calls without it return 400.',
      'An empty body returns 400 VALIDATION_ERROR.',
      'org_number uniqueness is enforced at DB level: 409 SUPPLIER_DUPLICATE_ORG_NUMBER.',
      'An archived supplier refuses a change to an identifying field with 400 VALIDATION_ERROR (details.field archived_at, details.offending_fields); send archived_at: null first.',
      'Changing default_expense_account does not rebook earlier supplier invoices: only future bookings pick up the new default.',
      'default_dimensions replaces the whole bag ({} clears it) and, like the default account, only tags supplier invoices registered after the change; with dimensions enabled an unknown or archived code returns 400 DIMENSION_VALIDATION_FAILED.',
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
  errorCodes: ['SUPPLIER_NOT_FOUND', 'SUPPLIER_DUPLICATE_ORG_NUMBER', 'VALIDATION_ERROR', 'DIMENSION_VALIDATION_FAILED'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/suppliers/:id',
    pathParams: { id: 'supplier_id' },
  },
  mcp: {
    name: 'gnubok_update_supplier',
    title: 'Update Supplier (Leverantör)',
    description:
      'Stage a partial edit of a supplier: contact, address, org/VAT number, bankgiro, plusgiro, clearing+account no, IBAN/BIC, default account and dimensions, payment terms, auto_debit (autogiro), notes. "" clears; archived_at null un-archives. supplier_id from gnubok_list_suppliers.',
    keywords: [
      'ändra leverantör',
      'uppdatera leverantör',
      'leverantörens dimension',
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

export const suppliersArchive = defineOperation({
  id: 'suppliers.archive',
  kind: 'write',
  scope: 'suppliers:write',
  // Medium like the v1 DELETE it shares its rule with: nothing is booked and
  // un-archiving undoes it, but a person decides which supplier leaves the
  // active register.
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Archive a supplier (soft-delete).',
    description:
      'Sets archived_at on the supplier; the record is preserved (supplier invoices and audit history remain intact) but excluded from default list responses. Refused while the supplier has an open supplier invoice (registered, approved, partially_paid, overdue or disputed). Un-archive with suppliers.update (archived_at: null). The dry run answers the supplier as it would read archived and writes nothing.',
    useWhen:
      'A supplier should leave the active register without losing its history, e.g. a duplicate left by an import once its invoices are closed.',
    doNotUseFor:
      'Merging two suppliers or moving a supplier invoice to another supplier: archiving moves nothing. Permanently deleting a supplier.',
    pitfalls: [
      'A supplier with any open supplier invoice returns 409 SUPPLIER_HAS_INVOICES (details.open_invoice_count): close the invoices first.',
      'The archived supplier keeps its supplier invoices; they still name it.',
      'An archived supplier refuses changes to its identifying fields until it is un-archived.',
    ],
    example: {
      request: { supplier_id: '0e9c…' },
      response: {
        data: { ...SUPPLIER_EXAMPLE, archived_at: '2026-05-12T09:00:00Z' },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: z.object({
    supplier_id: z.string().uuid().describe('The supplier to archive (gnubok_list_suppliers).'),
  }),
  output: SupplierRecordSchema,
  errorCodes: ['SUPPLIER_NOT_FOUND', 'SUPPLIER_HAS_INVOICES'],
  mcp: {
    name: 'gnubok_archive_supplier',
    title: 'Archive Supplier (Leverantör)',
    description:
      'Stage archiving a supplier: it leaves the active register and keeps its invoices and history. Refused while it has open supplier invoices. Moves nothing to another supplier. Undo: gnubok_update_supplier archived_at null. supplier_id from gnubok_list_suppliers.',
    keywords: [
      'arkivera leverantör',
      'ta bort leverantör',
      'dubblett leverantör',
      'dubbletter leverantörsregister',
      'inaktivera leverantör',
      'archive supplier',
      'delete supplier',
      'duplicate supplier',
    ],
    stage: {
      pendingType: 'archive_supplier',
      title: (_input, preview) => `Arkivera leverantör: ${String(preview?.name ?? '')}`.trim(),
    },
  },
  // The timestamp is taken when the call runs, at the dry run and again at
  // the commit: never part of what the approver pinned.
  volatilePreviewKeys: ['archived_at'],
  run: (ctx, { supplier_id }, { dryRun }) => archiveSupplier(ctx, supplier_id, { dryRun }),
})
