import type { UiWidget } from './types'

/**
 * Receipt Matcher Widget: MCP Apps inline HTML.
 * Drag-and-drop receipt attachment for uncategorized bank transactions.
 * Triggered by the gnubok_receipt_matcher tool.
 */

export const RECEIPT_MATCHER_HTML = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kvittomatchning - Accounted</title>
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
    --accent: #3b3b3b;
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
    --accent: #ccc;
    --drop-bg: rgba(255,255,255,0.03);
    --drop-active: rgba(122,171,122,0.12);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    padding: 12px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .header h1 { font-size: 15px; font-weight: 600; }
  .counter { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .loading { text-align: center; padding: 32px; color: var(--text-muted); }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-muted); padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr.booked { background: var(--success-bg); }
  tr.error-row { background: var(--error-bg); }
  .amount { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .amount.negative { color: var(--error); }
  .amount.positive { color: var(--success); }
  select {
    font-size: 12px; padding: 4px 6px; border: 1px solid var(--border);
    border-radius: 4px; background: var(--surface); color: var(--text);
    max-width: 140px;
  }
  .drop-zone {
    border: 1px dashed var(--border); border-radius: 6px;
    padding: 8px 12px; text-align: center; cursor: pointer;
    color: var(--text-muted); font-size: 11px;
    transition: background 0.15s, border-color 0.15s;
    min-width: 120px;
  }
  .drop-zone.active { background: var(--drop-active); border-color: var(--success); }
  .drop-zone.has-file { border-style: solid; border-color: var(--success); color: var(--success); }
  .drop-zone.disabled { opacity: 0.5; pointer-events: none; }
  .check { color: var(--success); font-weight: 600; }
  .error-msg { color: var(--error); font-size: 11px; margin-top: 2px; }
  .booking { font-size: 11px; color: var(--text-muted); }
  .empty { text-align: center; padding: 32px; color: var(--text-muted); }
</style>
</head>
<body>
<div class="header">
  <h1>Kvittomatchning</h1>
  <span class="counter" id="counter"></span>
</div>
<div id="content"><div class="loading">Laddar transaktioner\u2026</div></div>

<script>
(function() {
  // ── MCP Apps Bridge ──
  let rpcId = 1;
  const pending = new Map();
  let transactions = [];
  let categories = [];
  let vatTreatments = [];
  let booked = 0;

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

    // Response to our request
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }

    // Notifications from host
    if (msg.method === 'ui/notifications/tool-result') {
      const sc = msg.params?.structuredContent;
      if (sc) {
        transactions = sc.transactions || [];
        categories = sc.categories || [];
        vatTreatments = sc.vat_treatments || [];
        render();
      }
      return;
    }

    if (msg.method === 'ui/notifications/tool-input') return; // loading state already shown
    if (msg.method === 'ui/notifications/host-context-changed') {
      applyTheme(msg.params);
      return;
    }
  });

  function applyTheme(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }

  // ── Initialize ──
  sendRequest('ui/initialize', {
    name: 'gnubok-receipt-matcher',
    version: '1.0.0'
  }).then(function(res) {
    if (res && res.hostContext) applyTheme(res.hostContext);
    sendNotification('ui/notifications/initialized');
  }).catch(function() {
    sendNotification('ui/notifications/initialized');
  });

  // ── Render ──
  function render() {
    const el = document.getElementById('content');
    const counterEl = document.getElementById('counter');
    counterEl.textContent = booked + ' av ' + transactions.length + ' bokf\\u00f6rda';

    if (!transactions.length) {
      el.innerHTML = '<div class="empty">Inga okategoriserade transaktioner.</div>';
      return;
    }

    let html = '<table><thead><tr>' +
      '<th>Datum</th><th>Beskrivning</th><th class="amount">Belopp</th>' +
      '<th>Kategori</th><th>Moms</th><th>Kvitto</th>' +
      '</tr></thead><tbody>';

    transactions.forEach(function(tx, i) {
      const isBooked = tx._booked;
      const hasError = tx._error;
      const cls = isBooked ? 'booked' : (hasError ? 'error-row' : '');
      const amt = Number(tx.amount);
      const amtClass = amt < 0 ? 'negative' : 'positive';
      const formatted = amt.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';

      html += '<tr class="' + cls + '" data-idx="' + i + '">';
      html += '<td>' + esc(tx.date || '') + '</td>';
      html += '<td>' + esc(tx.description || tx.merchant_name || '') + '</td>';
      html += '<td class="amount ' + amtClass + '">' + formatted + '</td>';

      if (isBooked) {
        html += '<td colspan="3"><span class="check">\\u2713 Bokf\\u00f6rd</span></td>';
      } else if (tx._booking) {
        html += '<td colspan="3"><span class="booking">Bokar\\u2026</span></td>';
      } else {
        html += '<td><select id="cat-' + i + '">' + categoryOptions(tx) + '</select></td>';
        html += '<td><select id="vat-' + i + '">' + vatOptions() + '</select></td>';
        html += '<td>' + dropZone(i) + '</td>';
      }

      if (hasError) {
        html += '</tr><tr class="error-row"><td colspan="6"><span class="error-msg">' + esc(tx._error) + '</span></td>';
      }
      html += '</tr>';
    });

    html += '</tbody></table>';
    el.innerHTML = html;

    // Bind drop zones
    document.querySelectorAll('.drop-zone').forEach(function(dz) {
      const idx = parseInt(dz.dataset.idx);
      dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('active'); });
      dz.addEventListener('dragleave', function() { dz.classList.remove('active'); });
      dz.addEventListener('drop', function(e) {
        e.preventDefault();
        dz.classList.remove('active');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(idx, file);
      });
      dz.addEventListener('click', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,application/pdf';
        input.onchange = function() { if (input.files[0]) handleFile(idx, input.files[0]); };
        input.click();
      });
    });
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function categoryOptions(tx) {
    const cats = categories.length ? categories : [
      'income_services','income_products','income_other',
      'expense_equipment','expense_software','expense_travel','expense_office',
      'expense_marketing','expense_professional_services','expense_education',
      'expense_representation','expense_consumables','expense_vehicle',
      'expense_telecom','expense_bank_fees','expense_card_fees',
      'expense_currency_exchange','expense_other','private'
    ];
    const labels = {
      income_services:'Int\\u00e4kt tj\\u00e4nster', income_products:'Int\\u00e4kt varor', income_other:'Int\\u00e4kt \\u00f6vrigt',
      expense_equipment:'Utrustning', expense_software:'Programvara', expense_travel:'Resor',
      expense_office:'Kontor', expense_marketing:'Marknadsf\\u00f6ring',
      expense_professional_services:'Konsulter', expense_education:'Utbildning',
      expense_representation:'Representation', expense_consumables:'F\\u00f6rbrukning',
      expense_vehicle:'Fordon', expense_telecom:'Telekom', expense_bank_fees:'Bankavgifter',
      expense_card_fees:'Kortavgifter', expense_currency_exchange:'Valutav\\u00e4xling',
      expense_other:'\\u00d6vrig kostnad', private:'Privat'
    };
    const guess = (tx.amount < 0) ? 'expense_other' : 'income_services';
    return cats.map(function(c) {
      return '<option value="' + c + '"' + (c === guess ? ' selected' : '') + '>' + (labels[c] || c) + '</option>';
    }).join('');
  }

  function vatOptions() {
    const vats = vatTreatments.length ? vatTreatments : ['standard_25','reduced_12','reduced_6','reverse_charge','export','exempt'];
    const labels = { standard_25:'25%', reduced_12:'12%', reduced_6:'6%', reverse_charge:'Omv\\u00e4nd', export:'Export', exempt:'Undantagen' };
    return vats.map(function(v) {
      return '<option value="' + v + '"' + (v === 'standard_25' ? ' selected' : '') + '>' + (labels[v] || v) + '</option>';
    }).join('');
  }

  function dropZone(idx) {
    const tx = transactions[idx];
    if (tx._file) return '<div class="drop-zone has-file disabled" data-idx="' + idx + '">' + esc(tx._file) + '</div>';
    return '<div class="drop-zone" data-idx="' + idx + '">Sl\\u00e4pp kvitto</div>';
  }

  // ── File handling ──
  function handleFile(idx, file) {
    if (!file.type.match(/^image\\/|application\\/pdf/)) {
      transactions[idx]._error = 'Filtypen st\\u00f6ds inte. Anv\\u00e4nd bild eller PDF.';
      render();
      return;
    }

    const reader = new FileReader();
    reader.onload = function() {
      if (file.type.startsWith('image/')) {
        resizeImage(reader.result, function(dataUri) {
          transactions[idx]._file = file.name;
          transactions[idx]._dataUri = dataUri;
          transactions[idx]._mimeType = 'image/jpeg';
          render();
          bookTransaction(idx);
        });
      } else {
        // PDF: send as-is (no resize)
        transactions[idx]._file = file.name;
        transactions[idx]._dataUri = reader.result;
        transactions[idx]._mimeType = file.type;
        render();
        bookTransaction(idx);
      }
    };
    reader.readAsDataURL(file);
  }

  function resizeImage(dataUri, cb) {
    const img = new Image();
    img.onload = function() {
      const MAX = 1600;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = dataUri;
  }

  // ── Booking ──
  function bookTransaction(idx) {
    const tx = transactions[idx];
    const catEl = document.getElementById('cat-' + idx);
    const vatEl = document.getElementById('vat-' + idx);
    if (!catEl || !vatEl) return;

    tx._booking = true;
    tx._error = null;
    render();

    callTool('gnubok_categorize_transaction', {
      transaction_id: tx.id,
      category: catEl.value,
      vat_treatment: vatEl.value
    }).then(function(res) {
      tx._booking = false;
      // The tool result comes back as content[0].text (JSON string)
      let result;
      if (res && res.structuredContent) {
        result = res.structuredContent;
      } else if (res && res.content && res.content[0]) {
        try { result = JSON.parse(res.content[0].text); } catch(e) { result = {}; }
      }
      if (result && result.error) {
        tx._error = result.error;
      } else {
        tx._booked = true;
        booked++;
      }
      render();
      sendNotification('ui/updateContext', {
        content: [{ type: 'text', text: 'Bokf\\u00f6rt ' + booked + ' av ' + transactions.length + ' transaktioner.' }]
      });
    }).catch(function(err) {
      tx._booking = false;
      tx._error = (err && err.message) || 'Kunde inte boka transaktionen.';
      render();
    });
  }
})();
</script>
</body>
</html>`

export const receiptMatcherWidget: UiWidget = {
  uri: 'ui://receipt-matcher/app.html',
  name: 'Receipt Matcher',
  description: 'Interactive widget for matching receipts to uncategorized transactions',
  html: RECEIPT_MATCHER_HTML,
}
