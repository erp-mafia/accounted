-- AGI FK041 BostadsformanSmahusUlagAG vs FK043 BostadsformanEjSmahusUlagAG
-- distinguishes single-family-home (småhus) housing benefits from any other
-- type (lägenhet, hyresrätt, etc.). Both are boolean KRYSS in the XSD — the
-- AMOUNT belongs in FK012 SkatteplOvrigaFormanerUlagAG.
--
-- Housing benefit type is a long-term arrangement (employer provides this
-- specific dwelling for the employee), so it lives on the employees table
-- rather than per-line-item. NULL means no housing benefit; the column is
-- only consulted when the employee has a benefit_housing line item.

ALTER TABLE employees
  ADD COLUMN housing_benefit_type TEXT
    CHECK (housing_benefit_type IS NULL OR housing_benefit_type IN ('smahus', 'ej_smahus'));

COMMENT ON COLUMN employees.housing_benefit_type IS
  'When the employee receives a housing benefit, distinguishes småhus (FK041) from other dwellings (FK043) in the AGI XML. NULL = no housing benefit. Defaults to ej_smahus interpretation if a benefit_housing line item exists but this column is NULL.';

NOTIFY pgrst, 'reload schema';
