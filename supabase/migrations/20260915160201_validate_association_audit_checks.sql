-- Validate the two CHECKs 20260915160200 added NOT VALID on
-- annual_report_profiles, in their own transaction so the scan runs under
-- SHARE UPDATE EXCLUSIVE after the ADD CONSTRAINT lock has been released.
ALTER TABLE public.annual_report_profiles
  VALIDATE CONSTRAINT annual_report_profiles_auditor_report_opinion_check;
ALTER TABLE public.annual_report_profiles
  VALIDATE CONSTRAINT annual_report_profiles_auditor_report_deviations_length;
