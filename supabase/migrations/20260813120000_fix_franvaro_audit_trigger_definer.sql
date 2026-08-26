-- Fix: register_absence 500 for foraldraledighet/VAB from user-scoped surfaces.
--
-- Migration 20260517135000_skatteverket_audit_franvaro_lock.sql created
-- salary_absence_franvaro_audit with ENABLE ROW LEVEL SECURITY and ZERO
-- policies, and rewrote the specifikationsnummer trigger functions to INSERT
-- an audit row into it. That migration's comment claims the trigger "runs
-- SECURITY DEFINER (implicit in plpgsql functions that own the table)"; the
-- claim is false: plpgsql functions default to SECURITY INVOKER, so the audit
-- INSERT executes as the calling role. Under any non-BYPASSRLS role (role
-- authenticated: the dashboard absence POST, the web /pending approval, the
-- in-app Assistenten chat committing staged operations) the INSERT is denied
-- with SQLSTATE 42501, which aborts the whole salary_absence_days write. The
-- trigger fires only for absence_type IN ('vab', 'parental'), which is why
-- exactly those registrations failed with a generic 500 while 'sick' and
-- every other type kept working. Service-role paths (BYPASSRLS) were never
-- affected.
--
-- Fix: make both trigger functions SECURITY DEFINER so the audit INSERT runs
-- as the function owner (the migration runner, which also owns the audit
-- table; RLS is not FORCEd, so the owner is exempt). search_path is pinned
-- because SECURITY DEFINER without it is a privilege-escalation footgun.
--
-- Deliberately NO RLS policy is added on salary_absence_franvaro_audit: the
-- design intent is trigger/service-only writes, and an INSERT policy for
-- authenticated would let clients forge audit rows.

ALTER FUNCTION public.assign_franvaro_specifikationsnummer()
  SECURITY DEFINER
  SET search_path = public, pg_temp;

ALTER FUNCTION public.assign_franvaro_specifikationsnummer_on_update()
  SECURITY DEFINER
  SET search_path = public, pg_temp;
