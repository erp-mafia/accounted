import type { UiWidget } from './types'

/**
 * VAT Review Widget: MCP Apps inline HTML.
 * Read-only review of momsdeklaration (SKV 4700) before filing to Skatteverket.
 * Triggered by the gnubok_vat_review_widget tool.
 */

export const VAT_REVIEW_HTML = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Momsdeklaration: Accounted</title>
<style>
  :root {
    --bg: #fafafa;
    --surface: #ffffff;
    --border: rgba(0,0,0,0.1);
    --border-strong: rgba(0,0,0,0.18);
    --text: #1a1a1a;
    --text-muted: #6b6b6b;
    --text-faint: #999;
    --success: #5a7a5a;
    --success-bg: rgba(90,122,90,0.08);
    --error: #b35a3a;
    --error-bg: rgba(179,90,58,0.08);
    --accent: #3b3b3b;
    --code: #f0f0f0;
  }
  .dark {
    --bg: #161616;
    --surface: #1e1e1e;
    --border: rgba(255,255,255,0.1);
    --border-strong: rgba(255,255,255,0.18);
    --text: #e5e5e5;
    --text-muted: #999;
    --text-faint: #777;
    --success: #7aab7a;
    --success-bg: rgba(122,171,122,0.1);
    --error: #d4816a;
    --error-bg: rgba(212,129,106,0.1);
    --accent: #ccc;
    --code: #2a2a2a;
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
  .period { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .loading { text-align: center; padding: 32px; color: var(--text-muted); }

  .summary {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .summary.pay { border-left: 3px solid var(--error); }
  .summary.refund { border-left: 3px solid var(--success); }
  .summary.zero { border-left: 3px solid var(--text-faint); }
  .summary-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .warnings {
    background: var(--error-bg);
    border: 1px solid var(--error);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--error);
  }
  .warnings ul { margin: 0; padding-left: 20px; }
  .warnings-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .summary-amount {
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .summary-amount.pay { color: var(--error); }
  .summary-amount.refund { color: var(--success); }

  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  th {
    text-align: left;
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  th.amount { text-align: right; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  td.ruta-code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px;
    color: var(--text-faint);
    width: 60px;
  }
  td.amount {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  td.label { color: var(--text); }
  td.label .sub { display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; }

  tr.section td {
    background: var(--bg);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding-top: 14px;
    padding-bottom: 6px;
    font-weight: 500;
  }
  tr.total td {
    background: var(--bg);
    font-weight: 600;
    border-top: 1px solid var(--border-strong);
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  button {
    font-family: inherit;
    font-size: 12px;
    padding: 6px 12px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: var(--bg); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary {
    background: var(--accent);
    color: var(--surface);
    border-color: var(--accent);
  }
  button.primary:hover { opacity: 0.85; background: var(--accent); }
  .copied {
    display: inline-block;
    margin-right: 8px;
    font-size: 11px;
    color: var(--success);
    align-self: center;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .copied.shown { opacity: 1; }

  .empty { text-align: center; padding: 32px; color: var(--text-muted); }
</style>
</head>
<body>
<div class="header">
  <h1>Momsdeklaration</h1>
  <span class="period" id="period">-</span>
</div>
<div id="content"><div class="loading">Laddar…</div></div>

<script>
(function() {
  // ── MCP Apps Bridge ──
  let rpcId = 1
  const pending = new Map()
  let report = null

  function sendRequest(method, params) {
    const id = rpcId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
    })
  }
  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*')
  }

  window.addEventListener('message', function(e) {
    const msg = e.data
    if (!msg || msg.jsonrpc !== '2.0') return

    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(msg.error)
      else resolve(msg.result)
      return
    }

    if (msg.method === 'ui/notifications/tool-result') {
      const sc = msg.params && msg.params.structuredContent
      if (sc && sc.rutor) {
        report = sc
        render()
      }
      return
    }
    if (msg.method === 'ui/notifications/host-context-changed') {
      applyTheme(msg.params)
      return
    }
  })

  function applyTheme(ctx) {
    if (!ctx) return
    if (ctx.theme === 'dark') document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
  }

  sendRequest('ui/initialize', { name: 'gnubok-vat-review', version: '1.0.0' })
    .then(function(res) {
      if (res && res.hostContext) applyTheme(res.hostContext)
      sendNotification('ui/notifications/initialized')
    })
    .catch(function() { sendNotification('ui/notifications/initialized') })

  // ── Render ──
  function fmt(n) {
    return Number(n || 0).toLocaleString('sv-SE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' kr'
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

  function render() {
    const el = document.getElementById('content')
    const periodEl = document.getElementById('period')
    if (!report || !report.rutor) {
      el.innerHTML = '<div class="empty">Ingen momsdata för perioden.</div>'
      return
    }

    periodEl.textContent = report.period_label || ''
    const r = report.rutor
    const ruta49 = Number(r.ruta49 || 0)
    const summaryClass = ruta49 > 0 ? 'pay' : ruta49 < 0 ? 'refund' : 'zero'
    const summaryLabel = ruta49 > 0 ? 'Moms att betala' : ruta49 < 0 ? 'Moms att få tillbaka' : 'Noll i moms'
    const summaryAmt = fmt(Math.abs(ruta49))

    let html = ''

    // Pre-filing warnings (e.g. one-sided reverse charge): surface before the summary.
    const warnings = Array.isArray(report.warnings) ? report.warnings : []
    if (warnings.length > 0) {
      html += '<div class="warnings">'
      html += '<div class="warnings-title">Att granska före inlämning</div>'
      html += '<ul>'
      for (const w of warnings) html += '<li>' + esc(String(w)) + '</li>'
      html += '</ul>'
      html += '</div>'
    }

    html += '<div class="summary ' + summaryClass + '">'
    html += '  <div><div class="summary-label">' + esc(summaryLabel) + '</div></div>'
    html += '  <div class="summary-amount ' + summaryClass + '">' + esc(summaryAmt) + '</div>'
    html += '</div>'

    html += '<table>'
    html += '<thead><tr><th>Ruta</th><th>Beskrivning</th><th class="amount">Belopp</th></tr></thead>'
    html += '<tbody>'

    html += '<tr class="section"><td colspan="3">Försäljning</td></tr>'
    html += row('05', 'Momspliktig försäljning', 'all momspliktig försäljning oavsett skattesats', r.ruta05)
    html += row('35', 'EU-varuförsäljning (momsfri)', '3108', r.ruta35)
    html += row('39', 'Försäljning av tjänster (EU)', '3308', r.ruta39)
    html += row('40', 'Export', '3305', r.ruta40)

    html += '<tr class="section"><td colspan="3">Utgående moms</td></tr>'
    html += row('10', 'Utgående moms 25 %', '2611', r.ruta10)
    html += row('11', 'Utgående moms 12 %', '2621', r.ruta11)
    html += row('12', 'Utgående moms 6 %', '2631', r.ruta12)

    html += '<tr class="section"><td colspan="3">Utgående moms: omvänd betalningsskyldighet</td></tr>'
    html += row('30', 'Utgående moms 25 % (reverse charge)', '2614', r.ruta30)
    html += row('31', 'Utgående moms 12 % (reverse charge)', '2624', r.ruta31)
    html += row('32', 'Utgående moms 6 % (reverse charge)', '2634', r.ruta32)

    html += '<tr class="section"><td colspan="3">Ingående moms</td></tr>'
    html += row('48', 'Ingående moms', '2641 + 2645 + 2647', r.ruta48)

    html += '<tr class="total"><td class="ruta-code">49</td><td class="label">Att betala / återfå</td><td class="amount">' + fmt(ruta49) + '</td></tr>'

    html += '</tbody></table>'

    html += '<div class="actions">'
    html += '<span class="copied" id="copied">Kopierat</span>'
    html += '<button id="copy-json">Kopiera JSON</button>'
    html += '<button id="copy-summary" class="primary">Kopiera sammanfattning</button>'
    html += '</div>'

    el.innerHTML = html

    document.getElementById('copy-json').addEventListener('click', function() {
      copyToClipboard(JSON.stringify(report, null, 2))
    })
    document.getElementById('copy-summary').addEventListener('click', function() {
      const lines = [
        'Momsdeklaration ' + (report.period_label || ''),
        'Ruta 05: ' + fmt(r.ruta05),
        'Ruta 10: ' + fmt(r.ruta10),
        'Ruta 11: ' + fmt(r.ruta11),
        'Ruta 12: ' + fmt(r.ruta12),
        'Ruta 30: ' + fmt(r.ruta30),
        'Ruta 31: ' + fmt(r.ruta31),
        'Ruta 32: ' + fmt(r.ruta32),
        'Ruta 35: ' + fmt(r.ruta35),
        'Ruta 39: ' + fmt(r.ruta39),
        'Ruta 40: ' + fmt(r.ruta40),
        'Ruta 48: ' + fmt(r.ruta48),
        'Ruta 49: ' + fmt(r.ruta49) + '  (' + summaryLabel + ')',
      ]
      copyToClipboard(lines.join('\\n'))
    })
  }

  function row(code, label, sub, value) {
    return '<tr>'
      + '<td class="ruta-code">' + esc(code) + '</td>'
      + '<td class="label">' + esc(label) + '<span class="sub">' + esc(sub) + '</span></td>'
      + '<td class="amount">' + fmt(value) + '</td>'
      + '</tr>'
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied, showCopied)
    } else {
      // Fallback for older sandboxes
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch (_) {}
      document.body.removeChild(ta)
      showCopied()
    }
  }
  function showCopied() {
    const el = document.getElementById('copied')
    if (!el) return
    el.classList.add('shown')
    setTimeout(function() { el.classList.remove('shown') }, 1400)
  }
})()
</script>
</body>
</html>`

export const vatReviewWidget: UiWidget = {
  uri: 'ui://vat-review/app.html',
  name: 'VAT Review',
  description: 'Interactive review of momsdeklaration (SKV 4700) before filing',
  html: VAT_REVIEW_HTML,
}
