/**
 * Customer register (kundregister) operations served through the operation
 * doors. Create, update, list, get and archive stay the hand-written v1
 * routes and MCP tools they were.
 *
 * customers.merge (crm#1398, crm#1299): fold duplicate customer cards into
 * the card that stays (lib/customers/merge-customers.ts). An import that met
 * cards made by hand, or a customer entered twice, left one buyer's invoice
 * history on two cards, and no door could move it: a card on an issued
 * invoice is never deleted and nothing re-pointed an invoice. Agents
 * migrating a register asked for exactly this ("no safe merge/reassign/archive
 * tool exposed").
 *
 * Medium risk: nothing is booked and the dashboard can undo it for 30 days,
 * but the issued invoices then name the surviving card's buyer details.
 */
import { z } from 'zod'
import {
  CustomerMergeResultSchema,
  CustomerMergeUndoResultSchema,
  MergeCustomersSchema,
  mergeCustomers,
  undoCustomerMerge,
} from '@/lib/customers/merge-customers'
import { defineOperation } from './types'

export const customersMerge = defineOperation({
  id: 'customers.merge',
  kind: 'write',
  scope: 'customers:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Merge duplicate customers into one.',
    description:
      'Moves every invoice (quotes, proformas and credit notes included), sales order, recurring invoice, deadline and import source mapping of the merged customers to the survivor in one transaction, then archives the merged customers (kept, never deleted: issued invoices named them). Nothing on the survivor changes and no verifikat is touched. Refuses customers that state different org numbers, VAT numbers or personal numbers. The dry run answers the same counts and writes nothing. Requires Idempotency-Key.',
    useWhen:
      'One buyer has two or more customer cards, e.g. a card created by hand before an import from Fortnox or Visma, and its invoice history is split between them. Dry-run first and check the counts.',
    doNotUseFor:
      'Two different buyers that share an org number (departments of one authority): those are separate customers. Merging counterparties (Motparter), which have their own merge in the dashboard. Correcting a customer\'s details (PATCH the customer).',
    pitfalls: [
      'Idempotency-Key is mandatory.',
      'The survivor must be an active customer; a merged customer may already be archived.',
      'Issued invoices show the survivor\'s name and address from now on: pick the card whose details are right, or correct it first.',
      'Archived merged customers stay in the register for the retention period and cannot be hard-deleted.',
      'Undo is in the dashboard for 30 days (the toast after the merge).',
    ],
    example: {
      request: {
        survivor_customer_id: '7c1e…',
        merged_customer_ids: ['9a42…'],
      },
      response: {
        data: {
          survivor: { customer_id: '7c1e…', name: 'Exempel AB', customer_number: '120' },
          merged: [
            {
              customer_id: '9a42…',
              name: 'Exempel AB',
              customer_number: '120',
              merge_id: '3f0d…',
              was_archived: false,
              invoices: 1,
              sales_orders: 0,
              recurring_invoice_schedules: 0,
              deadlines: 0,
              source_records: 0,
            },
          ],
          totals: { invoices: 1, sales_orders: 0, recurring_invoice_schedules: 0, deadlines: 0 },
        },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: MergeCustomersSchema,
  output: CustomerMergeResultSchema,
  errorCodes: [
    'CUSTOMER_NOT_FOUND',
    'CUSTOMER_MERGE_IDENTITY_CONFLICT',
    'CUSTOMER_MERGE_SURVIVOR_ARCHIVED',
    'CUSTOMER_MERGE_FORBIDDEN',
    'VALIDATION_ERROR',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/customers/merge',
  },
  mcp: {
    name: 'gnubok_merge_customers',
    title: 'Merge Customers (Kunder)',
    description:
      'Stage a merge of duplicate customer cards: their invoices, orders, recurring invoices and deadlines move to survivor_customer_id, then they are archived. Refuses different org/VAT/personal numbers. Ids from gnubok_list_customers.',
    keywords: [
      'slå ihop kunder',
      'sammanfoga kunder',
      'dubblett kund',
      'dubbletter kundregister',
      'flytta fakturor till kund',
      'kundkort dubblett',
      'merge customers',
      'duplicate customer',
    ],
    stage: {
      pendingType: 'merge_customers',
      title: (_input, preview) => {
        const survivor = (preview?.survivor ?? {}) as { name?: string }
        const merged = (preview?.merged ?? []) as { name?: string }[]
        const names = merged.map((card) => card.name ?? '').filter(Boolean).join(', ')
        return `Slå ihop kunder: ${names} in i ${survivor.name ?? ''}`.replace(/\s+/g, ' ').trim()
      },
    },
  },
  run: (ctx, input, { dryRun }) => mergeCustomers(ctx, input, { dryRun }),
})

export const customersMergeUndo = defineOperation({
  id: 'customers.merge.undo',
  kind: 'write',
  scope: 'customers:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Undo a customer merge.',
    description:
      'Within 30 days of a merge: moves the invoices, sales orders, recurring invoices, deadlines and import source mappings the merge moved back to the merged customer, where they still point at the survivor, and restores the merged customer\'s archived state. Rows written to the survivor after the merge stay. The dry run checks the merge exists and can be undone. Requires Idempotency-Key.',
    useWhen: 'A merge joined two customers that are not the same buyer.',
    doNotUseFor: 'Splitting rows that were on the survivor before the merge: only what the merge moved comes back.',
    pitfalls: [
      'merge_id is merged[].merge_id from the merge\'s answer.',
      'Refused with CUSTOMER_MERGE_UNDO_BLOCKED while the survivor has since been merged into another customer: undo that merge first.',
      'After 30 days: CUSTOMER_MERGE_UNDO_EXPIRED.',
    ],
    example: {
      response: {
        data: {
          merge_id: '3f0d…',
          survivor_customer_id: '7c1e…',
          restored_customer_id: '9a42…',
          restored: { invoices: 1, sales_orders: 0, recurring_invoice_schedules: 0, deadlines: 0, source_records: 0 },
        },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: z.object({ merge_id: z.string().uuid().describe('merged[].merge_id from the merge.') }),
  output: CustomerMergeUndoResultSchema,
  errorCodes: [
    'CUSTOMER_MERGE_NOT_FOUND',
    'CUSTOMER_MERGE_ALREADY_UNDONE',
    'CUSTOMER_MERGE_UNDO_EXPIRED',
    'CUSTOMER_MERGE_UNDO_BLOCKED',
    'CUSTOMER_MERGE_FORBIDDEN',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/customers/merges/:mergeId/undo',
    pathParams: { mergeId: 'merge_id' },
  },
  run: (ctx, input, { dryRun }) => undoCustomerMerge(ctx, input.merge_id, { dryRun }),
})
