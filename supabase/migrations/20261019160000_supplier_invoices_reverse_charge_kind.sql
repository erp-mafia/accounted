SELECT set_config('lock_timeout', '5s', true);

-- Goods or services, for a supplier invoice under omvänd skattskyldighet
-- from a supplier in another EU country (crm#1323).
--
-- Every booking of such an invoice put the basis pair on 4535/4598 (ruta
-- 21, tjänster), whatever was bought, because the kind followed the
-- supplier type alone (reverseChargeKindForSupplierType). A purchase of
-- goods, a gemenskapsinternt förvärv, belongs on 4515/4598 (ruta 20;
-- swedish-vat skill 2.2-2.3): the fiktiv moms (2645/2614) is the same, the
-- box is not.
--
--   eu_goods     basis 4515/4516/4517, ruta 20
--   eu_services  basis 4535/4536/4537, ruta 21
--   NULL         services, the behaviour every existing row was booked with
--
-- Only an EU supplier's reverse-charge invoice carries a value: the create
-- doors refuse it anywhere else (resolveSupplierInvoiceReverseChargeKind in
-- src/lib/supplier-invoices/create.ts), and the booking reads it only for
-- an EU supplier (supplierInvoiceReverseChargeKind in
-- src/lib/bookkeeping/vat-entries.ts). Nothing is backfilled: a posted
-- verifikat is corrected by rättelse, never by changing this column.
--
-- Added NOT VALID and validated in 20261019160100, in a separate
-- transaction, so this file never scans the table under the ALTER's lock.
--
-- Grants: supplier_invoices keeps table-level privileges, so the column is
-- readable and writable exactly like the rest of the row under its RLS
-- policies.

ALTER TABLE public.supplier_invoices
  ADD COLUMN reverse_charge_kind text,
  ADD CONSTRAINT supplier_invoices_reverse_charge_kind_check CHECK (
    reverse_charge_kind IN ('eu_goods', 'eu_services')
  ) NOT VALID;

NOTIFY pgrst, 'reload schema';
