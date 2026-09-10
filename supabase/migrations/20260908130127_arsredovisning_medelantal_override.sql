-- arsredovisning_narratives: manual override for the medelantal anställda
-- note (ÅRL 5 kap. 20 §).
--
-- The note is otherwise computed as an FTE-weighted average over
-- public.employees. That is wrong for every company that books salary
-- without a Löner employee record (hand-booked salary, SIE import,
-- migrated history): 148 of 195 aktiebolag with posted 70xx-73xx lines in
-- prod have no employees rows at all, and the note then says "inga
-- anställda" although the owner drew salary all year. A half-year hire in
-- a broken fiscal year rounds 0.5 to 0 the same way.
--
-- NULL keeps the computed value. A whole number replaces it in the PDF note
-- and the iXBRL MedelantaletAnstallda fact for the same period. The column
-- is per-fiscal-period like the other disclosure overrides on this table.

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN medelantal_anstallda_override INTEGER
    CHECK (
      medelantal_anstallda_override IS NULL
      OR (medelantal_anstallda_override >= 0 AND medelantal_anstallda_override <= 100000)
    );

COMMENT ON COLUMN public.arsredovisning_narratives.medelantal_anstallda_override IS
  'Manual medelantal anställda for the ÅRL 5:20 § note. NULL = compute from employees.';

NOTIFY pgrst, 'reload schema';
