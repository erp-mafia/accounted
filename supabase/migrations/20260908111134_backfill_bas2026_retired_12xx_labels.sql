-- Backfill: retire the pre-2026 labels on 1249/1259/1269 where the company's
-- head account already carries the BAS 2026 free-account label (#2413).
--
-- BAS 2026 restructured kontogrupp 12: 1210 (maskiner, för produktion) and
-- 1220 (inventarier, ej för produktion) got the bilar/datorer sub-accounts,
-- while 1230/1240 became "(Fritt konto för Maskiner och andra tekniska
-- anläggningar)" and 1250/1260 "(Fritt konto för Inventarier, verktyg och
-- installationer)". The catalog in lib/bookkeeping/bas-data/ followed for the
-- heads but kept the retired contra accounts 1249/1259/1269 with their old
-- names, so a company that activated 1240 + 1249 from the picker got a free
-- machinery account whose only contra account said "bilar". The catalog now
-- names those contra accounts after their heads; this backfill does the same
-- for charts that already carry the contradictory pair.
--
-- Safety: a row is renamed only when BOTH hold: its name is byte-identical to
-- one of the two catalog literals it could have been seeded with, AND the
-- company's head account (1240/1250/1260) carries the BAS 2026 free label.
-- A chart imported from an older BAS (1240 "Bilar och andra transportmedel")
-- is internally consistent and is left alone, as is every user rename.
--
-- Third guard: the contra account has no journal lines. A SIE import whose
-- #KONTO names were not carried creates BOTH rows from the catalog
-- (lib/import/account-sync.ts create pass), so an old-BAS vehicle chart can
-- hold exactly the pair above with years of "Avskrivningar bil" postings on
-- 1249. A label with history is the user's to change; this backfill only
-- corrects the label the picker handed out before anything was booked on it.
-- No row is deleted; bookings key on account_number, never on the label.

UPDATE public.chart_of_accounts a
   SET account_name = 'Ackumulerade avskrivningar (fritt konto för Maskiner och andra tekniska anläggningar)',
       updated_at   = now()
 WHERE a.account_number = '1249'
   AND a.account_name IN (
         'Ack. avskrivningar på bilar och andra transportmedel',
         'Ackumulerade avskrivningar på bilar och andra transportmedel'
       )
   AND EXISTS (
         SELECT 1 FROM public.chart_of_accounts h
          WHERE h.company_id = a.company_id
            AND h.account_number = '1240'
            AND h.account_name = '(Fritt konto för Maskiner och andra tekniska anläggningar)'
       )
   AND NOT EXISTS (
         SELECT 1 FROM public.journal_entry_lines l
           JOIN public.journal_entries e ON e.id = l.journal_entry_id
          WHERE e.company_id = a.company_id
            AND l.account_number = a.account_number
       );

UPDATE public.chart_of_accounts a
   SET account_name = 'Ackumulerade avskrivningar (fritt konto för Inventarier, verktyg och installationer)',
       updated_at   = now()
 WHERE a.account_number = '1259'
   AND a.account_name IN (
         'Ack. avskrivningar på inventarier och verktyg',
         'Ackumulerade avskrivningar på inventarier och verktyg'
       )
   AND EXISTS (
         SELECT 1 FROM public.chart_of_accounts h
          WHERE h.company_id = a.company_id
            AND h.account_number = '1250'
            AND h.account_name = '(Fritt konto för Inventarier, verktyg och installationer)'
       )
   AND NOT EXISTS (
         SELECT 1 FROM public.journal_entry_lines l
           JOIN public.journal_entries e ON e.id = l.journal_entry_id
          WHERE e.company_id = a.company_id
            AND l.account_number = a.account_number
       );

UPDATE public.chart_of_accounts a
   SET account_name = 'Ackumulerade avskrivningar (fritt konto för Inventarier, verktyg och installationer)',
       updated_at   = now()
 WHERE a.account_number = '1269'
   AND a.account_name IN (
         'Ack. avskrivningar på datorer',
         'Ackumulerade avskrivningar på datorer'
       )
   AND EXISTS (
         SELECT 1 FROM public.chart_of_accounts h
          WHERE h.company_id = a.company_id
            AND h.account_number = '1260'
            AND h.account_name = '(Fritt konto för Inventarier, verktyg och installationer)'
       )
   AND NOT EXISTS (
         SELECT 1 FROM public.journal_entry_lines l
           JOIN public.journal_entries e ON e.id = l.journal_entry_id
          WHERE e.company_id = a.company_id
            AND l.account_number = a.account_number
       );
