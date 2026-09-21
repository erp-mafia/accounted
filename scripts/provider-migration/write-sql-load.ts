/** Generate a staging SQL load plan when HTTP credentials are unavailable.
 * This exercises real mapper output and database RPCs, not worker/network timing.
 * Execute the statements in order, only on erp-base staging.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mapVismaToSalesInvoice } from '../../lib/providers/visma/mapper'
import { mapBokioToSalesInvoice } from '../../lib/providers/bokio/mapper'
import { mapCustomer, mapSalesInvoice } from '../../extensions/general/arcim-migration/lib/entity-mapper'
import { invoiceFixture, type LoadProvider } from './fixtures'

const count = Number(process.argv[2] ?? 25000)
assert.ok(Number.isInteger(count) && count > 0 && count <= 100000)
const quote = (value: unknown) => "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb"
const plans = (['visma', 'bokio'] as LoadProvider[]).map(provider => {
  const company = randomUUID(), user = randomUUID(), consent = randomUUID(), worker = randomUUID()
  const templates = [0, 1, 2].map(index => {
    const dto = (provider === 'visma' ? mapVismaToSalesInvoice : mapBokioToSalesInvoice)(invoiceFixture(provider, index))
    const mapped = mapSalesInvoice(dto, user, company, '00000000-0000-0000-0000-000000000000')
    assert.equal(mapped.invoice.total, 375); assert.equal(mapped.items.length, 3)
    assert.equal(mapped.vatUnresolved, false)
    return { row: mapped.invoice, items: mapped.items,
      party: mapCustomer({ id: '', customerNumber: '', active: true, party: dto.customer }, user, company),
      link: { kind: 'customer', invoiceDate: dto.issueDate, totalSek: 375, currencyCode: 'SEK', sourceVoucher: null },
      warnings: { fxUnresolved: false, vatUnresolved: false, creditNoteUnlinked: false } }
  })
  const context = `PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
    PERFORM set_config('request.jwt.claim.role','service_role',true);
    SET LOCAL ROLE service_role;
    SELECT * INTO STRICT j FROM migration_jobs WHERE company_id='${company}';
    j:=claim_provider_migration_job('${worker}',j.id); ASSERT j.id IS NOT NULL,'lease unavailable';`
  const seed = `DO $$ DECLARE j migration_jobs; page integer; BEGIN
    INSERT INTO auth.users(id,email,instance_id) VALUES('${user}','sql-provider-load-${user}@test.invalid','00000000-0000-0000-0000-000000000000');
    INSERT INTO companies(id,name,entity_type,created_by) VALUES('${company}','SYNTHETIC SQL load ${provider} ${count}','aktiebolag','${user}');
    INSERT INTO company_members(company_id,user_id,role) VALUES('${company}','${user}','owner');
    INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES('${consent}','${company}','Synthetic SQL load','${provider}','556000-0000');
    INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES('${consent}','${provider}','synthetic-load-token');
    INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status) VALUES('${company}','${user}','synthetic-precondition.se','${company}',4,'completed');
    j:=create_provider_migration_job('${company}','${user}','${consent}',ARRAY['salesInvoices'],NULL);
    j:=claim_provider_migration_job('${worker}',j.id);
    FOR page IN 0..${Math.ceil(count / 250) - 1} LOOP
      PERFORM save_provider_migration_page(j.id,'${worker}',j.attempt,'salesInvoices',page+1,
        (SELECT jsonb_agg(jsonb_build_object('source_id','load-'||i,'payload','sql-benchmark-no-source-snapshot','payload_hash','synthetic'))
          FROM generate_series(page*250,least(${count - 1},page*250+249)) i),
        CASE WHEN page=${Math.ceil(count / 250) - 1} THEN NULL ELSE page+2 END);
    END LOOP;
    PERFORM release_provider_migration_job(j.id,'${worker}',j.attempt);
  END $$;
  SELECT id,company_id,phase,(SELECT count(*) FROM migration_job_chunks WHERE job_id=migration_jobs.id) AS records FROM migration_jobs WHERE company_id='${company}';`
  const batches = Array.from({ length: Math.ceil(count / 500) }, (_, batch) => {
    const start = batch * 500, end = Math.min(count - 1, start + 499)
    return `DO $$ DECLARE j migration_jobs; first integer; records jsonb; started timestamptz; elapsed double precision; max_ms double precision:=0;
      templates jsonb:=${quote(templates)}; BEGIN
      ${context}
      FOR first IN ${start}..${end} BY 10 LOOP
        SELECT jsonb_agg((templates->(i%3)) || jsonb_build_object('id',c.id,
          'party_source_id','customer-'||(i%250),
          'party',(templates->(i%3)->'party')||jsonb_build_object('name','Synthetic customer '||(i%250)),
          'row',(templates->(i%3)->'row')||jsonb_build_object('invoice_number',(i+1)::text),
          'link',(templates->(i%3)->'link')||jsonb_build_object('invoiceNumber',(i+1)::text))) INTO records
        FROM generate_series(first,least(first+9,${end})) i JOIN migration_job_chunks c ON c.job_id=j.id AND c.resource='salesInvoices' AND c.source_id='load-'||i;
        started:=clock_timestamp();
        PERFORM commit_provider_migration_records(j.id,'${worker}',j.attempt,records);
        -- Replay the committed batch to simulate a lost acknowledgement.
        PERFORM commit_provider_migration_records(j.id,'${worker}',j.attempt,records);
        elapsed:=extract(epoch FROM clock_timestamp()-started)*1000; max_ms:=greatest(max_ms,elapsed);
      END LOOP;
      ASSERT NOT EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='needs_attention'), 'unexpected failed record';
      PERFORM release_provider_migration_job(j.id,'${worker}',j.attempt);
      PERFORM set_config('provider_load.result',jsonb_build_object('provider','${provider}','through',${end + 1},'maxCommitAndReplayMs',max_ms)::text,true);
    END $$; SELECT current_setting('provider_load.result')::jsonb AS result;`
  })
  const finish = `DO $$ DECLARE j migration_jobs; records jsonb; BEGIN
    ${context}
    PERFORM advance_provider_migration_job(j.id,'${worker}',j.attempt);
    LOOP
      SELECT jsonb_agg(jsonb_build_object('id',c.id,'report',jsonb_build_object('invoiceId',c.target_id,'kind','customer','outcome','noRef','reason','synthetic invoice has no voucher reference')))
      INTO records FROM (SELECT id,target_id FROM migration_job_chunks WHERE job_id=j.id AND state='imported' ORDER BY resource_order,id LIMIT 10) c;
      EXIT WHEN records IS NULL;
      PERFORM commit_provider_migration_followup(j.id,'${worker}',j.attempt,records);
    END LOOP;
    FOR i IN 1..3 LOOP PERFORM advance_provider_migration_job(j.id,'${worker}',j.attempt); END LOOP;
    ASSERT (SELECT state='completed' FROM migration_jobs WHERE id=j.id),'job incomplete';
    ASSERT (SELECT count(*)=${count} AND sum(total)=${count * 375} AND sum(subtotal)=${count * 300} AND sum(vat_amount)=${count * 75} FROM invoices WHERE company_id='${company}'),'invoice count or totals mismatch';
    ASSERT (SELECT count(*)=${count * 3} FROM invoice_items l JOIN invoices i ON i.id=l.invoice_id WHERE i.company_id='${company}'),'line count mismatch';
    ASSERT (SELECT count(*)=${Math.min(count, 250)} FROM customers WHERE company_id='${company}'),'party count mismatch';
    ASSERT (SELECT count(*)=${count} FROM processing_history WHERE company_id='${company}' AND event_type='InvoiceRowsCompleted'),'completion events duplicated';
  END $$;
  SELECT '${provider}' AS provider,j.id,j.company_id,j.state,c.* FROM migration_jobs j CROSS JOIN LATERAL provider_migration_counts(j.id) c WHERE j.company_id='${company}';`
  return { provider, company, user, count, seed, batches, finish }
})
writeFileSync('.env.provider-sql-load-plan.json', JSON.stringify({ project: 'metjnjrhvujscngnpzdv', plans }))
console.log(`Generated two ${count}-invoice staging SQL plans. No queries executed.`)
