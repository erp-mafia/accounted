import type { UiWidget } from './types'

/**
 * Pending Operations Widget: MCP Apps inline HTML.
 * The approval queue for staged operations, rendered in the conversation.
 * Approve/reject are human CLICKS inside the widget, so the positive
 * acknowledgment for high-risk operations (BFL 5 kap 5§) is first-party
 * instead of agent-asserted: the widget arms the approve button and the
 * second click sends confirmed=true.
 * Triggered by gnubok_list_pending_operations with render_ui=true.
 */

export const PENDING_OPERATIONS_HTML = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Att godkänna - Accounted</title>
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
    --warn: #a5813c;
    --warn-bg: rgba(165,129,60,0.1);
    --accent: #3b3b3b;
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
    --warn: #c9a45e;
    --warn-bg: rgba(201,164,94,0.12);
    --accent: #ccc;
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
  .empty { text-align: center; padding: 32px; color: var(--text-muted); }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-muted); padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr.committed { background: var(--success-bg); }
  tr.rejected td { color: var(--text-muted); }
  tr.rejected .title { text-decoration: line-through; }
  tr.error-row { background: var(--error-bg); }
  .title { cursor: pointer; }
  .title:hover { text-decoration: underline; }
  .op-type { font-size: 11px; color: var(--text-muted); }
  .date { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--text-muted); }
  .chip {
    display: inline-block; font-size: 11px; padding: 1px 8px;
    border-radius: 99px; border: 1px solid var(--border);
    color: var(--text-muted); white-space: nowrap;
  }
  .chip.high { color: var(--error); border-color: var(--error); background: var(--error-bg); }
  .chip.medium { color: var(--warn); border-color: var(--warn); background: var(--warn-bg); }
  .actions { text-align: right; white-space: nowrap; }
  button {
    font-size: 12px; padding: 4px 12px; border-radius: 99px;
    border: 1px solid var(--border); background: var(--surface);
    color: var(--text); cursor: pointer; margin-left: 6px;
  }
  button:hover { background: var(--bg); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.approve { border-color: var(--success); color: var(--success); }
  button.approve.armed { background: var(--error-bg); border-color: var(--error); color: var(--error); font-weight: 600; }
  button.reject { color: var(--text-muted); }
  .check { color: var(--success); font-weight: 600; }
  .status-note { font-size: 11px; color: var(--text-muted); }
  .error-msg { color: var(--error); font-size: 11px; margin-top: 2px; }
  .preview-row td { background: var(--bg); padding: 8px 12px; }
  .preview-row pre {
    font-size: 11px; white-space: pre-wrap; word-break: break-word;
    max-height: 220px; overflow-y: auto; color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .arm-note { font-size: 11px; color: var(--error); display: block; margin-top: 2px; }
</style>
</head>
<body>
<div class="header">
  <h1>Att godkänna</h1>
  <span class="counter" id="counter"></span>
</div>
<div id="content"><div class="loading">Laddar väntande operationer…</div></div>

<script>
(function() {
  // ── MCP Apps Bridge ──
  let rpcId = 1;
  const pending = new Map();
  let operations = [];
  let handled = 0;
  // A host that never answers must not strand a row in "Arbetar..." with its
  // buttons gone: time the RPC out so the catch path restores the row and
  // the user can retry. 30s covers slow commits (journal posting, emails).
  const RPC_TIMEOUT_MS = 30000;

  function sendRequest(method, params) {
    const id = rpcId++;
    return new Promise(function(resolve, reject) {
      const timer = setTimeout(function() {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Inget svar fr\\u00e5n v\\u00e4rden inom 30 sekunder. F\\u00f6rs\\u00f6k igen.'));
        }
      }, RPC_TIMEOUT_MS);
      pending.set(id, {
        resolve: function(v) { clearTimeout(timer); resolve(v); },
        reject: function(e) { clearTimeout(timer); reject(e); }
      });
      window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
    });
  }

  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params }, '*');
  }

  function callTool(name, args) {
    return sendRequest('tools/call', { name: name, arguments: args });
  }

  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    if (msg.id != null && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
      return;
    }

    if (msg.method === 'ui/notifications/tool-result') {
      const sc = msg.params && msg.params.structuredContent;
      if (sc && sc.operations) {
        operations = sc.operations;
        handled = 0;
        render();
      }
      return;
    }

    if (msg.method === 'ui/notifications/tool-input') return;
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
    name: 'gnubok-pending-operations',
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
    counterEl.textContent = handled + ' av ' + operations.length + ' hanterade';

    if (!operations.length) {
      el.innerHTML = '<div class="empty">Inga v\\u00e4ntande operationer.</div>';
      return;
    }

    let html = '<table><thead><tr>' +
      '<th>Skapad</th><th>\\u00c5tg\\u00e4rd</th><th>Risk</th><th></th>' +
      '</tr></thead><tbody>';

    operations.forEach(function(op, i) {
      const cls = op._done === 'committed' ? 'committed' : (op._done === 'rejected' ? 'rejected' : (op._error ? 'error-row' : ''));
      html += '<tr class="' + cls + '" data-idx="' + i + '">';
      html += '<td class="date">' + esc((op.created_at || '').slice(0, 10)) + '</td>';
      html += '<td><span class="title" data-toggle="' + i + '">' + esc(op.title || op.operation_type || '') + '</span>' +
        '<div class="op-type">' + esc(op.operation_type || '') + (op.actor_label ? ' \\u00b7 ' + esc(op.actor_label) : '') + '</div>' +
        (op._error ? '<div class="error-msg">' + esc(op._error) + '</div>' : '') +
        '</td>';
      html += '<td>' + riskChip(op.risk_level) + '</td>';
      html += '<td class="actions">' + actionCell(op, i) + '</td>';
      html += '</tr>';

      if (op._expanded && op.preview_data) {
        html += '<tr class="preview-row"><td colspan="4"><pre>' +
          esc(JSON.stringify(op.preview_data, null, 2)) + '</pre></td></tr>';
      }
    });

    html += '</tbody></table>';
    el.innerHTML = html;

    document.querySelectorAll('[data-toggle]').forEach(function(t) {
      t.addEventListener('click', function() {
        const idx = parseInt(t.dataset.toggle);
        operations[idx]._expanded = !operations[idx]._expanded;
        render();
      });
    });
    document.querySelectorAll('button[data-approve]').forEach(function(b) {
      b.addEventListener('click', function() { approve(parseInt(b.dataset.approve)); });
    });
    document.querySelectorAll('button[data-reject]').forEach(function(b) {
      b.addEventListener('click', function() { reject(parseInt(b.dataset.reject)); });
    });
  }

  function riskChip(level) {
    if (level === 'high') return '<span class="chip high">h\\u00f6g</span>';
    if (level === 'medium') return '<span class="chip medium">medel</span>';
    return '<span class="chip">l\\u00e5g</span>';
  }

  function actionCell(op, i) {
    if (op._done === 'committed') return '<span class="check">\\u2713 Godk\\u00e4nd</span>';
    if (op._done === 'rejected') return '<span class="status-note">Avvisad</span>';
    if (op._working) return '<span class="status-note">Arbetar\\u2026</span>';
    let html = '';
    if (op._armed) {
      // Second click IS the positive BFL 5 kap 5\\u00a7 acknowledgment: it
      // sends confirmed=true. First-party human click, not agent-asserted.
      html += '<button class="approve armed" data-approve="' + i + '">Bekr\\u00e4fta bokf\\u00f6ring</button>';
      html += '<span class="arm-note">O\\u00e5terkallelig enligt BFL. Klicka igen f\\u00f6r att bekr\\u00e4fta.</span>';
    } else {
      html += '<button class="reject" data-reject="' + i + '">Avvisa</button>';
      html += '<button class="approve" data-approve="' + i + '">Godk\\u00e4nn</button>';
    }
    return html;
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function parseResult(res) {
    if (res && res.structuredContent) return res.structuredContent;
    if (res && res.content && res.content[0]) {
      try { return JSON.parse(res.content[0].text); } catch (e) { return {}; }
    }
    return {};
  }

  function errMsg(result, fallback) {
    if (result && result.error && typeof result.error === 'object') {
      return result.error.message_sv || result.error.message_en || fallback;
    }
    if (result && typeof result.error === 'string') return result.error;
    return null;
  }

  // ── Actions ──
  function approve(idx) {
    const op = operations[idx];
    if (op._done || op._working) return;
    if (op.risk_level === 'high' && !op._armed) {
      op._armed = true;
      render();
      return;
    }

    op._working = true;
    op._armed = false;
    op._error = null;
    render();

    const args = { operation_id: op.id };
    if (op.risk_level === 'high') args.confirmed = true;

    callTool('gnubok_approve_pending_operation', args).then(function(res) {
      op._working = false;
      const result = parseResult(res);
      const err = errMsg(result, 'Kunde inte godk\\u00e4nna operationen.');
      if (result.status === 'committed') {
        op._done = 'committed';
        handled++;
        notifyProgress('Godk\\u00e4nde "' + (op.title || op.operation_type) + '" via widgeten.');
      } else {
        op._error = err || 'Kunde inte godk\\u00e4nna operationen (status: ' + (result.status || 'ok\\u00e4nd') + ').';
      }
      render();
    }).catch(function(err) {
      op._working = false;
      op._error = (err && err.message) || 'Kunde inte godk\\u00e4nna operationen.';
      render();
    });
  }

  function reject(idx) {
    const op = operations[idx];
    if (op._done || op._working) return;

    op._working = true;
    op._error = null;
    render();

    callTool('gnubok_reject_pending_operation', {
      operation_id: op.id,
      reason: 'Avvisad i granskningswidgeten'
    }).then(function(res) {
      op._working = false;
      const result = parseResult(res);
      const err = errMsg(result, 'Kunde inte avvisa operationen.');
      if (err) {
        op._error = err;
      } else {
        op._done = 'rejected';
        handled++;
        notifyProgress('Avvisade "' + (op.title || op.operation_type) + '" via widgeten.');
      }
      render();
    }).catch(function(err) {
      op._working = false;
      op._error = (err && err.message) || 'Kunde inte avvisa operationen.';
      render();
    });
  }

  function notifyProgress(line) {
    sendNotification('ui/updateContext', {
      content: [{ type: 'text', text: line + ' ' + handled + ' av ' + operations.length + ' hanterade.' }]
    });
  }
})();
</script>
</body>
</html>`

export const pendingOperationsWidget: UiWidget = {
  uri: 'ui://pending-operations/app.html',
  name: 'Pending Operations',
  description: 'Interactive approval queue for staged operations: approve or reject with a human click',
  html: PENDING_OPERATIONS_HTML,
}
