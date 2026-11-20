-- Personalkategori: which BAS wage series an employee books on.
--
-- BAS keeps two series for wages: 70xx for kollektivanställda (arbetare:
-- 7010 löner, 7018 bruttolöneavdrag, 7081 sjuklöner, 7082 semesterlöner,
-- 7090 förändring av semesterlöneskuld) and 72xx for tjänstemän (7210, 7218,
-- 7281, 7285, 7290). Payroll booked everyone on 72xx, so a company with
-- kollektivanställda could not book them where their collective agreement's
-- insurer (Fora for arbetare, Collectum for tjänstemän) reads the totals.
--
-- employees.personnel_category is the setting; the salary account resolver
-- (lib/salary/account-mapping.ts) reads it at booking. It applies to
-- employment_type 'employee' only: owners (7220/7282/7286) and board members (7240)
-- keep their own accounts whatever it says.
--
-- salary_run_employees.personnel_category is the booking stamp: the booking
-- writes the category it posted with before it posts, so a later change on
-- the employee never rewrites what a booked run's Lönejournal shows. Rows
-- that exist today read 'tjansteman', which is how they were booked.

alter table public.employees
  add column personnel_category text not null default 'tjansteman'
  constraint employees_personnel_category_check
    check (personnel_category in ('arbetare', 'tjansteman'));

comment on column public.employees.personnel_category is
  'BAS wage series for employment_type employee: arbetare books 70xx (7010/7018/7081/7082/7090), tjansteman 72xx. Ignored for owners and board members.';

alter table public.salary_run_employees
  add column personnel_category text not null default 'tjansteman'
  constraint salary_run_employees_personnel_category_check
    check (personnel_category in ('arbetare', 'tjansteman'));

comment on column public.salary_run_employees.personnel_category is
  'The employee''s personnel_category as the run was booked with, stamped by the booking before it posts. Unbooked runs read the live employee value.';

notify pgrst, 'reload schema';
