-- One-shot repair for the substring reference auto-links (desk crm#64, 2026-09-16).
--
-- bulk-reconcile-supplier-vouchers auto-linked posted payment vouchers to open
-- supplier invoices on "Ankomstnummer N omnämnt i verifikatets beskrivning"
-- when N was a plain substring of a longer number in the text ("14" inside
-- "Levbet Tele2 Sverige AB (1814)"), with an amount that never matched the
-- invoice. Every such link in prod (31 rows, 8 companies, all partially_paid
-- with exactly that one payment row) is wrong. The matcher is fixed in the
-- same PR; this removes the wrong payment rows and restores the invoices'
-- paid/remaining/status.
--
-- No journal entry is touched: the vouchers are real payments of OTHER
-- invoices and stay posted. No bank transaction carries the wrong invoice id
-- (checked 2026-09-16). The repair is one transaction and idempotent: a
-- second run finds no rows. Run the dry run first and compare the count.

-- Dry run: what will be removed
select p.id as payment_id, c.name as company, s.name as supplier,
       si.supplier_invoice_number, si.arrival_number, si.total, p.amount, je.description
from supplier_invoice_payments p
join supplier_invoices si on si.id = p.supplier_invoice_id
join companies c on c.id = p.company_id
left join suppliers s on s.id = si.supplier_id
join journal_entries je on je.id = p.journal_entry_id
where p.notes like 'Auto-länkad vid avstämning%Ankomstnummer%omnämnt%'
  and je.description !~ ('(^|[^0-9])' || si.arrival_number::text || '($|[^0-9])')
order by c.name, si.supplier_invoice_number;

-- Repair
begin;

create temp table wrong_links on commit drop as
select p.id as payment_id, p.supplier_invoice_id, p.amount
from supplier_invoice_payments p
join supplier_invoices si on si.id = p.supplier_invoice_id
join journal_entries je on je.id = p.journal_entry_id
where p.notes like 'Auto-länkad vid avstämning%Ankomstnummer%omnämnt%'
  and je.description !~ ('(^|[^0-9])' || si.arrival_number::text || '($|[^0-9])');

delete from supplier_invoice_payments
where id in (select payment_id from wrong_links);

update supplier_invoices si
set paid_amount = greatest(0, round((coalesce(si.paid_amount, 0) - w.amount)::numeric, 2)),
    remaining_amount = least(si.total, round((coalesce(si.remaining_amount, si.total - coalesce(si.paid_amount, 0)) + w.amount)::numeric, 2)),
    status = case
      when coalesce(si.paid_amount, 0) - w.amount > 0.005 then 'partially_paid'
      when si.due_date < current_date then 'overdue'
      when si.approved_at is not null then 'approved'
      else 'registered'
    end
from (
  select supplier_invoice_id, sum(amount) as amount
  from wrong_links
  group by supplier_invoice_id
) w
where si.id = w.supplier_invoice_id;

select count(*) as removed_links from wrong_links;

commit;
