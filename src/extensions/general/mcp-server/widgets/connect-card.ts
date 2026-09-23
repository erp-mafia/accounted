import type { UiWidget } from './types'

/**
 * Connect Card Widget: MCP Apps inline HTML.
 * One-click "open in browser" card for the connect links returned by
 * gnubok_connect_bank and gnubok_connect_skatteverket. The button sends the
 * host a `ui/open-link` request (the only sanctioned way to open a new tab
 * from a widget); custom connectors always get Claude's confirmation modal,
 * so the destination URL is shown in the card for the user to recognize.
 * Which tool produced the result is detected from the structuredContent
 * shape: only the Skatteverket tool has an `available` field.
 */

export const CONNECT_CARD_HTML = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Anslut - Accounted</title>
<style>
  :root {
    --bg: #fafafa;
    --surface: #ffffff;
    --border: rgba(0,0,0,0.1);
    --text: #1a1a1a;
    --text-muted: #6b6b6b;
    --success: #5a7a5a;
    --success-bg: rgba(90,122,90,0.08);
    --accent: #1a1a1a;
    --accent-text: #ffffff;
    --url-bg: rgba(0,0,0,0.04);
  }
  .dark {
    --bg: #161616;
    --surface: #1e1e1e;
    --border: rgba(255,255,255,0.1);
    --text: #e5e5e5;
    --text-muted: #999;
    --success: #7aab7a;
    --success-bg: rgba(122,171,122,0.1);
    --accent: #e5e5e5;
    --accent-text: #161616;
    --url-bg: rgba(255,255,255,0.06);
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
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    max-width: 480px;
  }
  .card h1 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .lede { color: var(--text-muted); margin-bottom: 12px; }
  .status {
    display: inline-block; font-size: 12px; font-weight: 500;
    color: var(--success); background: var(--success-bg);
    border-radius: 999px; padding: 2px 10px; margin-bottom: 10px;
  }
  .url {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; color: var(--text-muted);
    background: var(--url-bg); border-radius: 4px;
    padding: 6px 8px; margin-bottom: 12px;
    word-break: break-all;
  }
  .actions { display: flex; gap: 8px; align-items: center; }
  button {
    font: inherit; font-weight: 500; cursor: pointer;
    border-radius: 6px; padding: 8px 14px;
    border: 1px solid var(--border);
    background: var(--surface); color: var(--text);
  }
  button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--success); outline-offset: 2px; }
  .note { margin-top: 10px; color: var(--text-muted); font-size: 12px; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1 id="title">Anslut</h1>
  <span class="status hidden" id="status">Ansluten</span>
  <p class="lede" id="lede">Laddar…</p>
  <div class="url hidden" id="url"></div>
  <div class="actions hidden" id="actions">
    <button class="primary" id="open">Öppna i webbläsaren</button>
    <button id="copy">Kopiera länk</button>
  </div>
  <p class="note hidden" id="note"></p>
</div>

<script>
(function() {
  // ── MCP Apps Bridge ──
  let rpcId = 1;
  const pending = new Map();
  let connectUrl = null;

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

  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }

    if (msg.method === 'ui/notifications/tool-result') {
      const sc = msg.params?.structuredContent;
      if (sc) render(sc);
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
    name: 'gnubok-connect-card',
    version: '1.0.0'
  }).then(function(res) {
    if (res && res.hostContext) applyTheme(res.hostContext);
    sendNotification('ui/notifications/initialized');
  }).catch(function() {
    sendNotification('ui/notifications/initialized');
  });

  // ── Render ──
  function el(id) { return document.getElementById(id); }
  function show(id) { el(id).classList.remove('hidden'); }
  function hide(id) { el(id).classList.add('hidden'); }

  function render(sc) {
    const isSkv = 'available' in sc;
    const isMigration = 'provider_name' in sc;
    connectUrl = sc.connect_url || null;
    el('title').textContent = isSkv
      ? 'Anslut Skatteverket'
      : isMigration
        ? 'Hämta från ' + sc.provider_name
        : 'Anslut din bank';

    if (isMigration) {
      el('lede').textContent = sc.api_connected
        ? 'Guiden loggar in hos ' + sc.provider_name + ' och hämtar bokföring, fakturor, kunder och underlag. Du behöver vara inloggad i Accounted i webbläsaren.'
        : sc.provider_name + ' saknar API-export: importera SIE-filen här först; guiden kompletterar sedan med fakturor och kunder.';
      if (connectUrl) {
        el('url').textContent = connectUrl;
        show('url');
        show('actions');
      }
      return;
    }

    if (isSkv && !sc.available) {
      el('lede').textContent = 'Skatteverket-kopplingen är inte aktiverad på den här installationen. Deklarationer kan fortfarande laddas ned som filer.';
      hide('url'); hide('actions'); hide('status');
      return;
    }

    if (sc.connected) {
      show('status');
      if (isSkv) {
        el('lede').textContent = 'Skatteverket är anslutet. Skattekontot synkas automatiskt och deklarationer kan lämnas in härifrån.';
        hide('url'); hide('actions');
        return;
      }
      const banks = (sc.connections || []).filter(function(c) { return c.status === 'active'; })
        .map(function(c) { return c.bank; }).filter(Boolean).join(', ');
      el('lede').textContent = (banks ? banks + ' är ansluten. ' : 'Minst en bank är ansluten. ') + 'Vill du lägga till ytterligare en bank?';
      el('open').textContent = 'Lägg till bank';
    } else {
      el('lede').textContent = isSkv
        ? 'Godkänn åtkomsten hos Skatteverket med BankID som firmatecknare. Du behöver vara inloggad i Accounted i webbläsaren.'
        : 'Välj din bank och godkänn med BankID (PSD2-samtycke, upp till 180 dagar). Du behöver vara inloggad i Accounted i webbläsaren.';
    }

    if (connectUrl) {
      el('url').textContent = connectUrl;
      show('url');
      show('actions');
    }
  }

  el('open').addEventListener('click', function() {
    if (!connectUrl) return;
    sendRequest('ui/open-link', { url: connectUrl }).then(function() {
      el('note').textContent = 'Länken öppnas i en ny flik. Kom tillbaka hit när du är klar.';
      show('note');
    }).catch(function() {
      el('note').textContent = 'Kunde inte öppna automatiskt. Kopiera länken och öppna den själv i webbläsaren.';
      show('note');
    });
  });

  el('copy').addEventListener('click', function() {
    if (!connectUrl) return;
    navigator.clipboard.writeText(connectUrl).then(function() {
      el('copy').textContent = 'Kopierad';
      setTimeout(function() { el('copy').textContent = 'Kopiera länk'; }, 1500);
    }).catch(function() {});
  });
})();
</script>
</body>
</html>
`

export const connectCardWidget: UiWidget = {
  uri: 'ui://connect-card/app.html',
  name: 'Connect Card',
  description:
    'One-click card for opening the bank or Skatteverket connect link in the browser. Rendered by gnubok_connect_bank and gnubok_connect_skatteverket.',
  html: CONNECT_CARD_HTML,
}
