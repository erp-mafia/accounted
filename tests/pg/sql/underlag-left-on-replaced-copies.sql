-- Synthetic fixtures only. Every write, including the posted fixtures, rolls back.
-- Migration 20261110090000: the count behind the migration workspace's offer
-- to run "Hämta underlag" again. A live verifikat counts when it has no
-- underlag while the copy a re-run migration reversed, of the same source
-- voucher in the same fiscal year, still holds one, and its year is open.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); other uuid:=gen_random_uuid();
  fy uuid:=gen_random_uuid(); fy_prev uuid:=gen_random_uuid(); fy_other uuid:=gen_random_uuid();
  imp_first uuid:=gen_random_uuid(); imp_second uuid:=gen_random_uuid();
  imp_prev_first uuid:=gen_random_uuid(); imp_prev_second uuid:=gen_random_uuid();
  imp_other_first uuid:=gen_random_uuid(); imp_other_second uuid:=gen_random_uuid();
  -- First copies (reversed by the re-run) and live copies, by case.
  c_moved uuid:=gen_random_uuid(); l_moved uuid:=gen_random_uuid();
  c_both uuid:=gen_random_uuid(); l_both uuid:=gen_random_uuid();
  c_bare uuid:=gen_random_uuid(); l_bare uuid:=gen_random_uuid();
  c_alone uuid:=gen_random_uuid();
  c_series uuid:=gen_random_uuid(); l_series uuid:=gen_random_uuid();
  c_year uuid:=gen_random_uuid(); l_year uuid:=gen_random_uuid();
  c_locked uuid:=gen_random_uuid(); l_locked uuid:=gen_random_uuid();
  c_other uuid:=gen_random_uuid(); l_other uuid:=gen_random_uuid();
  firsts uuid[]; lives uuid[]; o uuid; s uuid; n integer:=0;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES
    (company,'Replaced copy underlag test','aktiebolag',u),
    (other,'Another company','aktiebolag',u);
  -- The caller is a member of the first company only.
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO sie_imports(id,company_id,user_id,filename,file_hash,sie_type,status) VALUES
    (imp_first,company,u,'2026.se',md5('2026a'||company::text),4,'replaced'),
    (imp_second,company,u,'2026.se',md5('2026b'||company::text),4,'completed'),
    (imp_prev_first,company,u,'2025.se',md5('2025a'||company::text),4,'replaced'),
    (imp_prev_second,company,u,'2025.se',md5('2025b'||company::text),4,'completed'),
    (imp_other_first,other,u,'2026.se',md5('2026a'||other::text),4,'replaced'),
    (imp_other_second,other,u,'2026.se',md5('2026b'||other::text),4,'completed');
  INSERT INTO fiscal_periods(id,user_id,company_id,name,period_start,period_end,is_closed) VALUES
    (fy_prev,u,company,'2025','2025-01-01','2025-12-31',false),
    (fy,u,company,'2026','2026-01-01','2026-12-31',false),
    (fy_other,u,other,'2026','2026-01-01','2026-12-31',false);

  -- B1: the copy holds the file, the live copy has none (the state).
  -- B2: the live copy has a file of its own. B3: neither copy has one.
  -- B4: a reversed copy with a file and no live copy (an undone year).
  -- B5: the file sits on series C, the live copy is series B.
  -- B7: the copy with the file is a year earlier than the live copy.
  -- B6: the state, in a year that is locked afterwards.
  -- The other company has the state too (B1).
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
    source_type,status,source_voucher_series,source_voucher_number,import_batch_id,source_ordinal,source_content_hash)
  SELECT e.id,u,e.co,e.fp,e.no,e.ser,e.d,'Imported verifikat','import','draft',e.ser,e.snum,e.batch,e.ord,
    encode(sha256(convert_to(e.id::text,'UTF8')),'hex')
  FROM (VALUES
    (c_moved,company,fy,1,'B','2026-03-02'::date,1,imp_first,0),
    (c_both,company,fy,2,'B','2026-03-03'::date,2,imp_first,1),
    (c_bare,company,fy,3,'B','2026-03-04'::date,3,imp_first,2),
    (c_alone,company,fy,4,'B','2026-03-05'::date,4,imp_first,3),
    (c_series,company,fy,1,'C','2026-03-06'::date,5,imp_first,4),
    (l_moved,company,fy,5,'B','2026-03-02'::date,1,imp_second,0),
    (l_both,company,fy,6,'B','2026-03-03'::date,2,imp_second,1),
    (l_bare,company,fy,7,'B','2026-03-04'::date,3,imp_second,2),
    (l_series,company,fy,8,'B','2026-03-06'::date,5,imp_second,3),
    (l_year,company,fy,9,'B','2026-03-09'::date,7,imp_second,4),
    (c_year,company,fy_prev,1,'B','2025-03-09'::date,7,imp_prev_first,0),
    (c_locked,company,fy_prev,2,'B','2025-03-10'::date,6,imp_prev_first,1),
    (l_locked,company,fy_prev,3,'B','2025-03-10'::date,6,imp_prev_second,0),
    (c_other,other,fy_other,1,'B','2026-03-02'::date,1,imp_other_first,0),
    (l_other,other,fy_other,2,'B','2026-03-02'::date,1,imp_other_second,0)
  ) AS e(id,co,fp,no,ser,d,snum,batch,ord);
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
    SELECT id,'5010',100,0,'SEK',0 FROM journal_entries WHERE company_id IN (company,other)
    UNION ALL SELECT id,'1930',0,100,'SEK',1 FROM journal_entries WHERE company_id IN (company,other);

  firsts:=ARRAY[c_moved,c_both,c_bare,c_alone,c_series,c_year,c_locked,c_other];
  lives:=ARRAY[l_moved,l_both,l_bare,l_series,l_year,l_locked,l_other];
  UPDATE journal_entries SET status='posted' WHERE id=ANY(firsts);

  -- The re-run reverses the first copies the way undo_sie_import_chunk
  -- leaves them: a posted Makulering each, then the original reversed.
  FOREACH o IN ARRAY firsts LOOP
    n:=n+1;
    s:=gen_random_uuid();
    INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
      source_type,status,reverses_id)
      SELECT s,u,company_id,fiscal_period_id,100+n,'M',entry_date,'Makulering: '||description,'storno','draft',id
      FROM journal_entries WHERE id=o;
    INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
      SELECT s,account_number,credit_amount,debit_amount,currency,sort_order FROM journal_entry_lines WHERE journal_entry_id=o;
    UPDATE journal_entries SET status='posted' WHERE id=s;
    UPDATE journal_entries SET status='reversed',reversed_by_id=s WHERE id=o;
  END LOOP;
  UPDATE journal_entries SET status='posted' WHERE id=ANY(lives);

  -- The underlag an earlier "Hämta underlag" put on the first copies, and
  -- the one file of its own the B2 live copy has.
  INSERT INTO document_attachments(user_id,company_id,journal_entry_id,storage_path,file_name,sha256_hash,upload_source)
    SELECT u,(SELECT company_id FROM journal_entries WHERE id=e),e,'test/'||e::text||'.pdf','kvitto.pdf',repeat('a',64),'api'
    FROM unnest(ARRAY[c_moved,c_both,l_both,c_alone,c_series,c_year,c_locked,c_other]) e;
  -- Locked after the files came in: the trigger refuses a link there now.
  UPDATE fiscal_periods SET locked_at=now() WHERE id=fy_prev;

  ASSERT public.underlag_left_on_replaced_copies(company)=1,
    'expected only B1: a live copy without underlag whose reversed copy holds one, in an open year';
  ASSERT public.underlag_left_on_replaced_copies(other)=1,'the other company has its own case';

  -- The caller's RLS decides what it counts: its own company, never another.
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  ASSERT public.underlag_left_on_replaced_copies(company)=1,'a member does not see its own company''s case';
  ASSERT public.underlag_left_on_replaced_copies(other)=0,'a member counted another company''s verifikat';
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  ASSERT public.underlag_left_on_replaced_copies(company)=1,'the service role reads the company as given';
  RESET ROLE;

  -- What the run does: the live copy gets its own document, and the count
  -- drops. The reversed copy keeps its file.
  INSERT INTO document_attachments(user_id,company_id,journal_entry_id,storage_path,file_name,sha256_hash,upload_source)
    VALUES(u,company,l_moved,'test/live.pdf','kvitto.pdf',repeat('a',64),'api');
  ASSERT public.underlag_left_on_replaced_copies(company)=0,'the live copy has its underlag now';
  ASSERT (SELECT count(*)=1 FROM document_attachments WHERE journal_entry_id=c_moved),'the reversed copy lost its file';
END $$;
ROLLBACK;
