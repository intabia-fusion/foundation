//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Single static page, no build step: plain HTML + inline JS, served as-is on GET /.
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Webhook mock</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; background: #f5f5f7; color: #1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  main { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  section { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; flex: 1 1 460px; min-width: 420px; }
  label { display: block; font-size: 12px; color: #555; margin: 10px 0 4px; }
  input[type=text], select, textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; }
  textarea, pre, code { font-family: ui-monospace, Menlo, Consolas, monospace; }
  textarea { min-height: 160px; resize: vertical; }
  pre { background: #f0f0f2; border: 1px solid #ddd; border-radius: 4px; padding: 8px; overflow: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  button { margin-top: 10px; padding: 6px 12px; font-size: 13px; border: 1px solid #888; border-radius: 4px; background: #fff; cursor: pointer; }
  button:hover { background: #eee; }
  button:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; gap: 12px; }
  .row > * { flex: 1; }
  .radio-row { display: flex; gap: 16px; margin: 4px 0; font-size: 13px; }
  .radio-row label { display: flex; align-items: center; gap: 4px; margin: 0; }
  .status-ok { color: #0a7d20; font-weight: 600; }
  .status-bad { color: #c11; font-weight: 600; }
  .muted { color: #888; font-size: 12px; }
  details { border: 1px solid #ddd; border-radius: 4px; margin-bottom: 8px; padding: 6px 8px; }
  summary { cursor: pointer; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0; }
  td { padding: 2px 4px; vertical-align: top; border-bottom: 1px solid #eee; }
  td.h { color: #555; white-space: nowrap; width: 220px; }
  .readonly-url { display: flex; gap: 6px; }
  .readonly-url input { font-size: 12px; }
</style>
</head>
<body>
<h1>Webhook mock</h1>
<p class="muted">Dev-only tool for services/webhook/pod-webhook. Left: send an incoming webhook call. Right: receive outgoing deliveries and check their signature.</p>
<main>

<section id="send">
  <h2>Send (incoming webhook)</h2>
  <label>API key</label>
  <input type="text" id="apikey" placeholder="fus_...">
  <div class="radio-row">
    <label><input type="radio" name="keyloc" value="header" checked> key in Authorization header</label>
    <label><input type="radio" name="keyloc" value="path"> key in path (/k/:key)</label>
  </div>
  <label>Action preset</label>
  <select id="action"></select>
  <label>Body (editable JSON)</label>
  <textarea id="body"></textarea>
  <button id="send-btn">Send</button>
  <div id="send-result"></div>
  <div id="job-area" style="display:none">
    <label>jobId</label>
    <div class="row">
      <input type="text" id="jobid" readonly>
      <button id="poll-btn" style="flex:0 0 auto">Poll job</button>
    </div>
    <pre id="job-result"></pre>
  </div>
</section>

<section id="receive">
  <h2>Receive (outgoing webhook)</h2>
  <label>Receiving URL - server-to-server (paste into WebhookEndpoint.url)</label>
  <div class="readonly-url">
    <input type="text" id="url-internal" readonly>
  </div>
  <label>Receiving URL - from this browser, via nginx</label>
  <div class="readonly-url">
    <input type="text" id="url-external" readonly>
  </div>

  <label>Respond to incoming deliveries with</label>
  <div class="radio-row" id="response-mode">
    <label><input type="radio" name="mode" value="200" checked> 200</label>
    <label><input type="radio" name="mode" value="500"> 500</label>
    <label><input type="radio" name="mode" value="429"> 429</label>
  </div>

  <label>Receiver secret (whsec_...) - to check webhook-signature</label>
  <input type="text" id="secret" placeholder="whsec_...">

  <div class="row" style="margin-top:12px">
    <button id="refresh-btn">Refresh</button>
    <button id="clear-btn">Clear</button>
    <label style="display:flex;align-items:center;gap:4px;flex:0 0 auto;margin:10px 0 0"><input type="checkbox" id="auto-refresh" checked> auto</label>
  </div>

  <div id="deliveries" style="margin-top:12px"></div>
</section>

</main>
<script>
const ACTIONS = {
  'issue:create': { space: 'PROJ', title: 'Sample issue from webhook mock', description: 'Created via mock webhook UI', priority: 'medium' },
  'issue:update': { space: 'PROJ-1', status: 'In Progress', priority: 'high' },
  'issue:comment': { space: 'PROJ-1', message: 'Comment posted via mock webhook UI' },
  'chat:post': { space: 'general', message: 'Hello from mock webhook UI' },
  'doc:create': { space: 'My Teamspace', title: 'Sample document', content: '# Hello\\n\\nCreated via mock webhook UI' },
  'doc:update': { space: '<document-ref>', title: 'Updated title' }
}

// Served both at the root and behind nginx under /_webhook-mock/ - resolve API calls against the
// page, or they hit the front and come back as HTML.
const API_BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/'
const api = (path) => API_BASE + 'api/' + path

const actionSelect = document.getElementById('action')
const bodyArea = document.getElementById('body')
for (const name of Object.keys(ACTIONS)) {
  const opt = document.createElement('option')
  opt.value = name
  opt.textContent = name
  actionSelect.appendChild(opt)
}
function fillPreset () {
  const action = actionSelect.value
  bodyArea.value = JSON.stringify({ action, ...ACTIONS[action] }, null, 2)
}
actionSelect.addEventListener('change', fillPreset)
fillPreset()

// Dev tool: key and signing secret survive a reload, so a test run is not retyping them.
for (const [id, slot] of [['apikey', 'wh-mock-apikey'], ['secret', 'wh-mock-secret']]) {
  const el = document.getElementById(id)
  el.value = localStorage.getItem(slot) ?? ''
  el.addEventListener('input', () => { localStorage.setItem(slot, el.value.trim()) })
}

document.getElementById('send-btn').addEventListener('click', async () => {
  const key = document.getElementById('apikey').value.trim()
  const keyLocation = document.querySelector('input[name=keyloc]:checked').value
  const resultEl = document.getElementById('send-result')
  const jobArea = document.getElementById('job-area')
  jobArea.style.display = 'none'
  let payload
  try {
    payload = JSON.parse(bodyArea.value)
  } catch (err) {
    resultEl.innerHTML = '<p class="status-bad">Body is not valid JSON: ' + err.message + '</p>'
    return
  }
  resultEl.innerHTML = '<p class="muted">Sending...</p>'
  try {
    const res = await fetch(api('send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, keyLocation, payload })
    })
    const data = await res.json()
    const cls = data.status >= 200 && data.status < 300 ? 'status-ok' : 'status-bad'
    resultEl.innerHTML = '<p class="' + cls + '">HTTP ' + data.status + '</p><pre>' + escapeHtml(JSON.stringify(data.body, null, 2)) + '</pre>'
    const jobId = data.body && data.body.jobId
    if (typeof jobId === 'string') {
      document.getElementById('jobid').value = jobId
      jobArea.style.display = 'block'
      document.getElementById('job-result').textContent = ''
    }
  } catch (err) {
    resultEl.innerHTML = '<p class="status-bad">' + escapeHtml(String(err)) + '</p>'
  }
})

document.getElementById('poll-btn').addEventListener('click', async () => {
  const key = document.getElementById('apikey').value.trim()
  const jobId = document.getElementById('jobid').value.trim()
  const out = document.getElementById('job-result')
  out.textContent = 'Polling...'
  const res = await fetch(api('job'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, jobId })
  })
  const data = await res.json()
  out.textContent = 'HTTP ' + data.status + '\\n' + JSON.stringify(data.body, null, 2)
})

// --- receive side ---
const urlInternal = document.getElementById('url-internal')
const urlExternal = document.getElementById('url-external')
urlInternal.value = 'http://webhook-mock:4044/receive'
// Relative to the current page, so it works both proxied under nginx (/_webhook-mock/) and served directly.
urlExternal.value = new URL('receive', location.href).toString()

document.querySelectorAll('#response-mode input').forEach((el) => {
  el.addEventListener('change', async () => {
    await fetch(api('response-mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: Number(el.value) })
    })
  })
})

document.getElementById('clear-btn').addEventListener('click', async () => {
  await fetch(api('deliveries/clear'), { method: 'POST' })
  await loadDeliveries()
})
document.getElementById('refresh-btn').addEventListener('click', loadDeliveries)

const HIGHLIGHT_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-webhook-delivery-id', 'x-webhook-attempt']

async function loadDeliveries () {
  const res = await fetch(api('deliveries'))
  const items = await res.json()
  const secret = document.getElementById('secret').value.trim()
  const container = document.getElementById('deliveries')
  container.innerHTML = ''
  if (items.length === 0) {
    container.innerHTML = '<p class="muted">No deliveries received yet.</p>'
    return
  }
  for (const item of items) {
    const details = document.createElement('details')
    const time = new Date(item.receivedAt).toLocaleTimeString()
    const summary = document.createElement('summary')
    summary.textContent = time + ' - webhook-id=' + (item.headers['webhook-id'] ?? '?') + ', attempt=' + (item.headers['x-webhook-attempt'] ?? '?')
    details.appendChild(summary)

    const table = document.createElement('table')
    for (const name of HIGHLIGHT_HEADERS) {
      table.innerHTML += '<tr><td class="h">' + name + '</td><td>' + escapeHtml(item.headers[name] ?? '') + '</td></tr>'
    }
    details.appendChild(table)

    const allHeaders = document.createElement('details')
    allHeaders.innerHTML = '<summary>all headers</summary><pre>' + escapeHtml(JSON.stringify(item.headers, null, 2)) + '</pre>'
    details.appendChild(allHeaders)

    const bodyPre = document.createElement('pre')
    bodyPre.textContent = item.rawBody
    details.appendChild(bodyPre)

    if (secret.length > 0) {
      const verifyEl = document.createElement('p')
      try {
        const vres = await fetch(api('deliveries/' + item.id + '/verify'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret })
        })
        const v = await vres.json()
        if (v.match) {
          verifyEl.innerHTML = '<span class="status-ok">signature OK</span>'
        } else {
          verifyEl.innerHTML = '<span class="status-bad">signature MISMATCH' + (v.reason ? ' (' + escapeHtml(v.reason) + ')' : '') + '</span>'
        }
      } catch (err) {
        verifyEl.innerHTML = '<span class="status-bad">' + escapeHtml(String(err)) + '</span>'
      }
      details.appendChild(verifyEl)
    }

    container.appendChild(details)
  }
}

function escapeHtml (str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

loadDeliveries()
setInterval(() => {
  if (document.getElementById('auto-refresh').checked) loadDeliveries()
}, 3000)
</script>
</body>
</html>
`
