/**
 * The instructor and seat live board: one self-contained page that reads `?cohort=` and the
 * `#token=` fragment, then follows `/ws`. Agent text is untrusted, so the page writes it only
 * through `textContent`.
 */

/**
 * Render the board page for one CSP nonce.
 * @param nonce - Per-response script nonce.
 * @returns The HTML document.
 */
export function boardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audit Board</title>
<style>
:root { --bg: #fafafa; --fg: #1d1d1f; --muted: #6b6b70; --line: #e2e2e6; --card: #fff; --deny: #b42318; --warn: #b54708; --think: #5b21b6; }
@media (prefers-color-scheme: dark) { :root { --bg: #111114; --fg: #ececf1; --muted: #9a9aa3; --line: #2a2a31; --card: #18181d; --deny: #f97066; --warn: #fdb022; --think: #c4b5fd; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; gap: 12px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 16px; margin: 0; }
#status { color: var(--muted); }
main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 16px; }
@media (min-width: 1100px) { main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: auto; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0; padding: 10px 12px; border-bottom: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: 12px; }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
.deny { color: var(--deny); font-weight: 600; }
.warn { color: var(--warn); }
.think { color: var(--think); }
.muted { color: var(--muted); }
#feed li { list-style: none; padding: 6px 12px; border-bottom: 1px solid var(--line); }
#feed { margin: 0; padding: 0; }
details summary { cursor: pointer; }
pre { white-space: pre-wrap; margin: 4px 0 0; font: 12px/1.4 ui-monospace, monospace; }
</style>
</head>
<body>
<header><h1>Audit Board</h1><span id="cohort"></span><span id="status">connecting</span></header>
<main>
<section><h2>Seats</h2><table><thead><tr><th>Student</th><th>Session</th><th>Model</th><th class="n">Records</th><th class="n">Reasoning</th><th class="n">Tools</th><th class="n">Errors</th><th class="n">Denials</th><th>Last</th></tr></thead><tbody id="seats"></tbody></table></section>
<section><h2>Live feed</h2><ul id="feed"></ul></section>
</main>
<script nonce="${nonce}">
const params = new URLSearchParams(location.search)
const token = new URLSearchParams(location.hash.slice(1)).get('token') || ''
const cohort = params.get('cohort') || ''
const seats = new Map()
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node }
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? s + 's ago' : Math.round(s / 60) + 'm ago' }
document.getElementById('cohort').textContent = cohort ? 'cohort ' + cohort : 'no cohort selected'
function renderSeats() {
  const body = document.getElementById('seats'); body.replaceChildren()
  for (const seat of [...seats.values()].sort((a, b) => b.lastMs - a.lastMs)) {
    for (const [id, card] of Object.entries(seat.sessions).sort((a, b) => b[1].lastMs - a[1].lastMs).slice(0, 3)) {
      const row = el('tr')
      row.append(el('td', seat.student + ' / ' + seat.installation), el('td', card.title || id.slice(0, 12)), el('td', card.model || ''),
        el('td', card.records, 'n'), el('td', card.reasoningChars, card.reasoningChars ? 'n think' : 'n muted'), el('td', card.toolCalls, 'n'),
        el('td', card.toolErrors, card.toolErrors ? 'n warn' : 'n'), el('td', card.scopeDenials, card.scopeDenials ? 'n deny' : 'n'), el('td', ago(card.lastMs), 'muted'))
      body.append(row)
    }
  }
}
function absorb(activity) {
  const seat = seats.get(activity.installation) || { student: activity.student, installation: activity.installation, lastMs: 0, sessions: {} }
  const card = seat.sessions[activity.sessionId] || { title: null, model: null, records: 0, reasoningChars: 0, toolCalls: 0, toolErrors: 0, scopeDenials: 0, lastMs: 0 }
  card.records++; card.reasoningChars += activity.reasoningChars; card.toolCalls += activity.toolCalls; card.toolErrors += activity.toolErrors
  card.scopeDenials += activity.scopeDenials; card.title = activity.title || card.title; card.model = activity.model || card.model; card.lastMs = activity.receivedMs
  seat.sessions[activity.sessionId] = card; seat.lastMs = activity.receivedMs; seats.set(activity.installation, seat)
}
function feed(activity) {
  const item = el('li')
  const line = el('div')
  line.append(el('span', new Date(activity.receivedMs).toLocaleTimeString() + ' ', 'muted'), el('span', activity.student + ' #' + activity.seq + ' '),
    el('span', activity.text, activity.scopeDenials ? 'deny' : activity.toolErrors ? 'warn' : activity.reasoningChars ? 'think' : ''))
  item.append(line)
  if (activity.reasoning) { const more = el('details'); more.append(el('summary', 'reasoning'), el('pre', activity.reasoning)); item.append(more) }
  const list = document.getElementById('feed'); list.prepend(item)
  while (list.children.length > 300) list.lastChild.remove()
}
let delay = 1000
function connect() {
  if (!token || !cohort) { document.getElementById('status').textContent = 'open as /board?cohort=<cohort>#token=<token>'; return }
  const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?cohort=' + encodeURIComponent(cohort) + '&token=' + encodeURIComponent(token))
  const ping = setInterval(() => { if (socket.readyState === 1) socket.send('ping') }, 30000)
  socket.onopen = () => { delay = 1000; document.getElementById('status').textContent = 'live' }
  socket.onmessage = (event) => {
    if (event.data === 'pong') return
    const message = JSON.parse(event.data)
    if (message.type === 'snapshot') { seats.clear(); for (const seat of message.seats) seats.set(seat.installation, seat); document.getElementById('feed').replaceChildren(); for (const activity of message.recent) feed(activity) }
    if (message.type === 'activity') for (const activity of message.activities) { absorb(activity); feed(activity) }
    renderSeats()
  }
  socket.onclose = () => { clearInterval(ping); document.getElementById('status').textContent = 'reconnecting'; setTimeout(connect, delay); delay = Math.min(delay * 2, 30000) }
}
connect()
setInterval(renderSeats, 15000)
</script>
</body>
</html>
`
}
