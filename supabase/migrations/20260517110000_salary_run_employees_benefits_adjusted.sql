-- Flag for AGI FK048 FormanHarJusterats — emitted on an IU when a benefit
-- value has been adjusted away from the schablon (e.g. car benefit reduced
-- because the employee uses the car less than the standard assumption, or
-- a housing benefit set below the typical jämförelsehyra). Skatteverket
-- expects the flag set whenever any förmånsvärde on the IU has been
-- justerat downward — they may follow up with questions.
--
-- We track it per salary_run_employees row because adjustments are decided
-- and recorded at run time, not on the employee master.

ALTER TABLE salary_run_employees
  ADD COLUMN benefits_adjusted BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN salary_run_employees.benefits_adjusted IS
  'When true, the AGI XML emits FK048 FormanHarJusterats=1 on this IU. Set when any förmånsvärde on the row has been adjusted away from the standard schablon.';

NOTIFY pgrst, 'reload schema';
