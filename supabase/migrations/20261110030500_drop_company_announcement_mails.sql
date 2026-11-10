-- Drops the send log of the one-time announcement mail (20261109180000).
-- The announcement sender was removed before it ever sent anything: the
-- founder did not want an announcement, and the table held zero rows.

DROP TABLE IF EXISTS public.company_announcement_mails;

NOTIFY pgrst, 'reload schema';
