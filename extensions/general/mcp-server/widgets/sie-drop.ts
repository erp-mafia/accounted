import type { UiWidget } from './types'

/**
 * SIE Drop Widget: MCP Apps inline HTML rendered by gnubok_create_sie_upload.
 * The user drags their .se/.sie export onto the card; the widget reads the
 * EXACT bytes itself (FileReader), computes sha256, and passes them through
 * `tools/call` as file_content_base64: no model in the byte path, so a
 * 100 KB+ file imports without token-by-token reproduction risk. Flow:
 * drop → gnubok_sie_preflight (verdict shown in the card) → user clicks
 * Importera → gnubok_import_sie with the preflight's mappings (stages for
 * approval as always). The tool's upload_url stays available as a fallback
 * for hosts without the widget.
 */

export const SIE_DROP_HTML = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SIE-import - Accounted</title>
<style>
  :root {
    --bg: #fafafa;
    --surface: #ffffff;
    --border: rgba(0,0,0,0.1);
    --text: #1a1a1a;
    --text-muted: #6b6b6b;
    --success: #5a7a5a;
    --success-bg: rgba(90,122,90,0.08);
    --error: #b35a3a;
    --error-bg: rgba(179,90,58,0.08);
    --accent: #1a1a1a;
    --accent-text: #ffffff;
    --drop-bg: rgba(0,0,0,0.03);
    --drop-active: rgba(90,122,90,0.12);
  }
  .dark {
    --bg: #161616;
    --surface: #1e1e1e;
    --border: rgba(255,255,255,0.1);
    --text: #e5e5e5;
    --text-muted: #999;
    --success: #7aab7a;
    --success-bg: rgba(122,171,122,0.1);
    --error: #d4816a;
    --error-bg: rgba(212,129,106,0.1);
    --accent: #e5e5e5;
    --accent-text: #161616;
    --drop-bg: rgba(255,255,255,0.03);
    --drop-active: rgba(122,171,122,0.12);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--bg); color: var(--text);
    font-size: 13px; line-height: 1.5; padding: 12px;
  }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; max-width: 520px; }
  h1 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .lede { color: var(--text-muted); margin-bottom: 12px; }
  .drop {
    border: 2px dashed var(--border); border-radius: 8px;
    background: var(--drop-bg); padding: 28px 16px; text-align: center;
    color: var(--text-muted); cursor: pointer; transition: background 150ms, border-color 150ms;
  }
  .drop.active { background: var(--drop-active); border-color: var(--success); }
  .hidden { display: none; }
  .report { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .row .k { color: var(--text-muted); }
  .row .v { font-variant-numeric: tabular-nums; text-align: right; }
  .status { display: inline-block; font-size: 12px; font-weight: 500; border-radius: 999px; padding: 2px 10px; margin-bottom: 8px; }
  .status.ok { color: var(--success); background: var(--success-bg); }
  .status.bad { color: var(--error); background: var(--error-bg); }
  .warnings { margin-top: 8px; color: var(--error); font-size: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  button {
    font: inherit; font-weight: 500; cursor: pointer; border-radius: 6px;
    padding: 8px 14px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text);
  }
  button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button:focus-visible { outline: 2px solid var(--success); outline-offset: 2px; }
  .note { margin-top: 10px; color: var(--text-muted); font-size: 12px; }
  input[type="file"] { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>Importera bokföring (SIE)</h1>
  <p class="lede">Släpp SIE-filen här så kontrolleras den innan något bokförs.</p>
  <div class="drop" id="drop">Släpp .se/.sie-filen här, eller klicka för att välja</div>
  <input type="file" id="picker" accept=".se,.sie,.si" />
  <div class="report hidden" id="report"></div>
  <div class="actions hidden" id="actions">
    <button class="primary" id="import">Importera</button>
  </div>
  <p class="note hidden" id="note"></p>
</div>

<script>
(function() {
  // ── MCP Apps Bridge ──
  let rpcId = 1;
  const pending = new Map();
  let fileState = null; // { name, base64, sha256, preflight }

  function sendRequest(method, params) {
    const id = rpcId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }
  function callTool(name, args) {
    return sendRequest('tools/call', { name: name, arguments: args });
  }
  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error); else resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/host-context-changed') applyTheme(msg.params);
  });
  function applyTheme(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }
  sendRequest('ui/initialize', { name: 'gnubok-sie-drop', version: '1.0.0' })
    .then(function(res) {
      if (res && res.hostContext) applyTheme(res.hostContext);
      sendNotification('ui/notifications/initialized');
    })
    .catch(function() { sendNotification('ui/notifications/initialized'); });

  // ── Helpers ──
  function el(id) { return document.getElementById(id); }
  function show(id) { el(id).classList.remove('hidden'); }
  function hide(id) { el(id).classList.add('hidden'); }
  function note(text) { el('note').textContent = text; show('note'); }

  function toBase64(buffer) {
    const u8 = new Uint8Array(buffer);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }
  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function parseResult(res) {
    if (res && res.structuredContent) return res.structuredContent;
    try { return JSON.parse(res.content[0].text); } catch (e) { return null; }
  }

  // ── Drop handling ──
  const drop = el('drop');
  drop.addEventListener('click', function() { el('picker').click(); });
  el('picker').addEventListener('change', function(e) {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });
  ;['dragover', 'dragenter'].forEach(function(ev) {
    drop.addEventListener(ev, function(e) { e.preventDefault(); drop.classList.add('active'); });
  });
  ;['dragleave', 'drop'].forEach(function(ev) {
    drop.addEventListener(ev, function(e) { e.preventDefault(); drop.classList.remove('active'); });
  });
  drop.addEventListener('drop', function(e) {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  function handleFile(file) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.se') && !lower.endsWith('.sie') && !lower.endsWith('.si')) {
      note('Filen måste vara en SIE-export (.se eller .sie).');
      return;
    }
    drop.textContent = 'Kontrollerar ' + file.name + '…';
    const reader = new FileReader();
    reader.onload = function() {
      const buffer = reader.result;
      crypto.subtle.digest('SHA-256', buffer).then(function(hash) {
        const base64 = toBase64(buffer);
        const sha256 = toHex(hash);
        fileState = { name: file.name, base64: base64, sha256: sha256, preflight: null };
        sendNotification('ui/updateContext', {
          content: 'Användaren släppte ' + file.name + ' på importkortet; preflight körs med exakta bytes (sha256 ' + sha256.slice(0, 12) + '…).'
        });
        callTool('gnubok_sie_preflight', {
          filename: file.name,
          file_content_base64: base64,
          sha256: sha256
        }).then(function(res) {
          const sc = parseResult(res);
          if (!sc) { drop.textContent = 'Kunde inte läsa svaret. Försök igen.'; return; }
          fileState.preflight = sc;
          renderReport(sc);
        }).catch(function(err) {
          drop.textContent = 'Preflight misslyckades: ' + (err && err.message ? err.message : 'okänt fel');
        });
      }).catch(function() {
        note('Kunde inte beräkna filens kontrollsumma i denna miljö. Ladda upp via app.accounted.se/import?mode=sie i stället.');
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function renderReport(sc) {
    drop.textContent = fileState.name;
    const ok = sc.verdict === 'ok' || sc.verdict === 'ok_with_warnings';
    const f = sc.file || {};
    const rows = [
      ['Företag', (f.company_name || '?') + ' (' + (f.org_number || '?') + ')'],
      ['Räkenskapsår', ((f.fiscal_year || {}).start || '?') + ' – ' + ((f.fiscal_year || {}).end || '?')],
      ['Verifikat', String(f.voucher_count != null ? f.voucher_count : '?')],
      ['Konton', String(f.account_count != null ? f.account_count : '?')],
    ];
    let html = '<span class="status ' + (ok ? 'ok' : 'bad') + '">' +
      (sc.verdict === 'ok' ? 'Ser korrekt ut'
        : sc.verdict === 'ok_with_warnings' ? 'OK med anmärkningar'
        : sc.verdict === 'duplicate' ? 'Redan importerad'
        : 'Ogiltig fil') + '</span>';
    rows.forEach(function(r) {
      html += '<div class="row"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
    });
    const warnings = ((sc.validation || {}).warnings || []).concat((sc.validation || {}).errors || []);
    if (warnings.length > 0) {
      html += '<div class="warnings">' + warnings.slice(0, 3).map(function(w) { return '• ' + w; }).join('<br>') + '</div>';
    }
    el('report').innerHTML = html;
    show('report');
    if (ok) { show('actions'); el('import').disabled = false; }
    else hide('actions');
  }

  el('import').addEventListener('click', function() {
    if (!fileState || !fileState.preflight) return;
    el('import').disabled = true;
    el('import').textContent = 'Importerar…';
    callTool('gnubok_import_sie', {
      filename: fileState.name,
      file_content_base64: fileState.base64,
      sha256: fileState.sha256,
      mappings: fileState.preflight.mappings || [],
      create_fiscal_period: true,
      import_opening_balances: true,
      import_transactions: true
    }).then(function(res) {
      const sc = parseResult(res);
      el('import').textContent = 'Import förberedd';
      note('Importen är förberedd och väntar på godkännande: säg till i chatten eller godkänn i Accounted, så bokförs verifikationerna.');
      sendNotification('ui/updateContext', {
        content: 'SIE-importen av ' + fileState.name + ' är stagead' + (sc && sc.operation_id ? ' (operation ' + sc.operation_id + ')' : '') + ' och väntar på godkännande.'
      });
    }).catch(function(err) {
      el('import').disabled = false;
      el('import').textContent = 'Importera';
      note('Import misslyckades: ' + (err && err.message ? err.message : 'okänt fel'));
    });
  });
})();
</script>
</body>
</html>
`

export const sieDropWidget: UiWidget = {
  uri: 'ui://sie-drop/app.html',
  name: 'SIE Import Drop',
  description:
    'Drag-and-drop SIE import card: reads the exact file bytes, runs gnubok_sie_preflight, and stages gnubok_import_sie on click. Rendered by gnubok_create_sie_upload.',
  html: SIE_DROP_HTML,
}
