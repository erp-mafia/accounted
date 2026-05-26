-- Persist FranvaroSpecifikationsnummer per (employee, year-month) for AGI
-- Frånvarouppgift stability across corrections.
--
-- Before this migration the xml generator computed the number as a 1-based
-- index over sorted absence dates. Skatteverket's spec key for matching a
-- replacement is (BetalningsmottagarId, FranvaroDatum,
-- FranvaroSpecifikationsnummer, RedovisningsPeriod, AgRegistreradId). The
-- date is in the key so adding new days is safe — but deleting a day mid-
-- period would shift every later day's index, causing Skatteverket to see
-- one Frånvarouppgift as a *replacement* of a different earlier one
-- (because the FranvaroDatum changes too) and the earlier one as orphaned.
--
-- Assigning the number on INSERT and never re-numbering makes the
-- correction path safe: if a day is deleted, its number is freed but
-- nothing else moves; if a day is added, it gets max+1. Pre-existing
-- vab/parental rows are backfilled in date order.

ALTER TABLE salary_absence_days
  ADD COLUMN franvaro_specifikationsnummer INTEGER;

-- Backfill existing vab/parental rows: sort by absence_date within each
-- (employee, YYYYMM) bucket and assign sequential numbers from 1. Older
-- rows get lower numbers so the first AGI submission for the period (which
-- happens shortly after the month ends) stays consistent with what was
-- already filed before this migration.
--
-- The year-month key is computed as YEAR*100+MONTH (e.g. 202605) rather
-- than date_trunc('month', …) because expressions used in unique indexes
-- must be IMMUTABLE, and date_trunc(text, date) resolves to the STABLE
-- timestamptz overload on PostgreSQL < 14 (and even on newer versions with
-- some search_path / overload-resolution combinations). extract(year/month
-- from date) is unambiguously IMMUTABLE.
WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY employee_id, (extract(year FROM absence_date)::int * 100 + extract(month FROM absence_date)::int)
      ORDER BY absence_date, id
    ) AS rn
  FROM salary_absence_days
  WHERE absence_type IN ('vab', 'parental')
)
UPDATE salary_absence_days sad
   SET franvaro_specifikationsnummer = numbered.rn
  FROM numbered
 WHERE sad.id = numbered.id;

-- One number per (employee, year-month, type-applicable-row). The partial
-- index lets sick/pregnancy/etc rows leave the column NULL.
CREATE UNIQUE INDEX idx_salary_absence_days_franvaro_specnum
  ON salary_absence_days (
    employee_id,
    (extract(year FROM absence_date)::int * 100 + extract(month FROM absence_date)::int),
    franvaro_specifikationsnummer
  )
  WHERE franvaro_specifikationsnummer IS NOT NULL;

-- Trigger: assign max+1 within the (employee, year-month) bucket on INSERT
-- when the column is NULL and the type warrants a Frånvarouppgift.
-- Skatteverket only reports VAB (TILLFALLIG_FORALDRAPENNING) and parental
-- (FORALDRAPENNING) — sick days go to Försäkringskassan via a separate
-- channel, and the other types (pregnancy, care_relative, study,
-- other_leave) are not reported as Frånvarouppgifter at all.
CREATE OR REPLACE FUNCTION public.assign_franvaro_specifikationsnummer()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.franvaro_specifikationsnummer IS NULL
     AND NEW.absence_type IN ('vab', 'parental') THEN
    SELECT COALESCE(MAX(franvaro_specifikationsnummer), 0) + 1
      INTO NEW.franvaro_specifikationsnummer
      FROM salary_absence_days
     WHERE employee_id = NEW.employee_id
       AND (extract(year FROM absence_date)::int * 100 + extract(month FROM absence_date)::int)
         = (extract(year FROM NEW.absence_date)::int * 100 + extract(month FROM NEW.absence_date)::int)
       AND franvaro_specifikationsnummer IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salary_absence_days_assign_franvaro_specnum
  BEFORE INSERT ON salary_absence_days
  FOR EACH ROW EXECUTE FUNCTION public.assign_franvaro_specifikationsnummer();

-- If a row's type later changes from sick→vab/parental, assign a number on
-- that UPDATE too (otherwise NULL would emit no Frånvarouppgift). The
-- reverse transition (vab→sick) keeps the number — harmless because we
-- only emit for vab/parental anyway and re-using the slot is fine.
CREATE OR REPLACE FUNCTION public.assign_franvaro_specifikationsnummer_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.franvaro_specifikationsnummer IS NULL
     AND NEW.absence_type IN ('vab', 'parental') THEN
    SELECT COALESCE(MAX(franvaro_specifikationsnummer), 0) + 1
      INTO NEW.franvaro_specifikationsnummer
      FROM salary_absence_days
     WHERE employee_id = NEW.employee_id
       AND (extract(year FROM absence_date)::int * 100 + extract(month FROM absence_date)::int)
         = (extract(year FROM NEW.absence_date)::int * 100 + extract(month FROM NEW.absence_date)::int)
       AND franvaro_specifikationsnummer IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER salary_absence_days_assign_franvaro_specnum_update
  BEFORE UPDATE OF absence_type ON salary_absence_days
  FOR EACH ROW
  WHEN (NEW.absence_type IN ('vab', 'parental') AND OLD.franvaro_specifikationsnummer IS NULL)
  EXECUTE FUNCTION public.assign_franvaro_specifikationsnummer_on_update();

COMMENT ON COLUMN salary_absence_days.franvaro_specifikationsnummer IS
  'Stable per-(employee, year-month) sequence number for AGI Frånvarouppgift FK822. Assigned on INSERT for vab/parental rows; never re-numbered. Lets corrections survive day deletions without shifting numbers on remaining days.';

NOTIFY pgrst, 'reload schema';
