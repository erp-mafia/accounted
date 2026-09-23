import { z } from 'zod'
import {
  CreateInvoiceFromSalesOrderSchema,
  CreateSalesOrderSchema,
  RegisterSalesOrderDeliverySchema,
  SalesOrderTransitionSchema,
} from '@/lib/api/schemas'

// Commit-boundary re-validation for the staged kundorder (sales order)
// operations. A staged pending_operations row is re-parsed here before the
// lib/sales-orders service runs so a tampered row cannot inject unexpected
// fields or malformed data (defense in depth, ASVS V4.5): mirrors
// lib/pending-operations/schemas/article.ts.
//
// The shapes are the same Zod schemas the cookie routes under
// app/api/sales-orders validate with, so the MCP door and the web door
// accept exactly the same payloads. Every executor also needs the target
// order, which the route carries in the URL and the staged params carry as
// sales_order_id.

const salesOrderId = z.string().uuid()

export const CreateSalesOrderParamsSchema = CreateSalesOrderSchema

export const TransitionSalesOrderParamsSchema = SalesOrderTransitionSchema.extend({
  sales_order_id: salesOrderId,
})

export const RegisterSalesOrderDeliveryParamsSchema = RegisterSalesOrderDeliverySchema.extend({
  sales_order_id: salesOrderId,
})

export const CreateInvoiceFromSalesOrderParamsSchema = CreateInvoiceFromSalesOrderSchema.extend({
  sales_order_id: salesOrderId,
})
