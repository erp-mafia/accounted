ALTER TABLE public.salary_line_items
  ADD COLUMN one_off_tax_percent numeric(5,2),
  ADD CONSTRAINT salary_line_one_off_tax_valid CHECK (
    one_off_tax_percent IS NULL OR (
      one_off_tax_percent BETWEEN 0 AND 100 AND amount > 0 AND is_taxable
      AND NOT is_gross_deduction AND NOT is_net_deduction
      AND item_type IN ('bonus', 'commission', 'other', 'correction', 'semesterersattning')
    )
  );
COMMENT ON COLUMN public.salary_line_items.one_off_tax_percent IS
  'Explicit operator-verified one-off withholding percentage. NULL uses regular tax. A valid employee percentage decision overrides this.';
NOTIFY pgrst, 'reload schema';
