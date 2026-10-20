export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WPINV Dashboard</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c2430; --muted:#667085; --line:#e4e7ec; --ok:#12805c; --warn:#b54708; --bad:#c01048; --info:#175cd3; --chip:#f2f4f7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1318; --card:#171c23; --text:#e6e9ee; --muted:#98a2b3; --line:#2a313b; --ok:#47cd89; --warn:#fdb022; --bad:#f97066; --info:#84adff; --chip:#222933; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); background:var(--card); display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; }
  h1 { font-size:18px; margin:0 12px 0 0; }
  h2 { font-size:15px; margin:0 0 10px; }
  main { padding:16px 20px; display:grid; gap:16px; max-width:1300px; margin:0 auto; }
  .chip { background:var(--chip); border-radius:999px; padding:2px 10px; font-size:12px; color:var(--muted); }
  .chip b { color:var(--text); font-weight:600; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .kpi, section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .kpi .v { font-size:24px; font-weight:650; }
  .kpi .l { color:var(--muted); font-size:12px; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; white-space:nowrap; }
  .a { font-weight:600; white-space:nowrap; }
  .created,.existing,.edited { color:var(--ok); } .clarify { color:var(--warn); } .error { color:var(--bad); } .respond,.dry_run { color:var(--info); } .ignore { color:var(--muted); }
  .muted { color:var(--muted); } .small { font-size:12px; }
  .tag { display:inline-block; font-size:11px; line-height:1.5; padding:0 7px; border-radius:999px; background:var(--chip); color:var(--muted); }
  .tag.backup { background:var(--warn); color:var(--card); font-weight:600; }
  .empty { color:var(--muted); padding:12px 0; }
  pre { white-space:pre-wrap; margin:0; font:inherit; }
  @media (max-width:640px) { header, main { padding-left:16px; padding-right:16px; } }
</style>
</head>
<body>
<header>
  <h1>WPINV</h1>
  <span id="info" class="small"></span>
  <span class="chip small" id="updated">loading…</span>
</header>
<main>
  <div class="kpis" id="kpis"></div>
  <section><h2>Recent activity</h2><div class="scroll"><table id="activity"></table></div></section>
  <section><h2>Open clarifications</h2><div id="pending"></div></section>
  <section><h2>Evaluation (mocked Zoho, measured)</h2><div class="scroll" id="eval"></div></section>
</main>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const money = (n) => n == null ? '–' : '₹' + Number(n).toLocaleString('en-IN');
const time = (t) => new Date(t).toLocaleTimeString();
const pct = (r) => r && r.pct != null ? r.pct + '% <span class="muted">(' + r.num + '/' + r.den + ')</span>' : 'n/a';
const label = { created:'Invoiced', existing:'Already invoiced', edited:'Edited', dry_run:'Dry run', clarify:'Asked', respond:'Replied', ignore:'Ignored', error:'Error' };

async function get(p) { const r = await fetch(p, { cache: 'no-store' }); return r.json(); }

// Which LLM read each message. Older log rows marked the backup with a " (fallback)" suffix.
const isBackup = (a) => Boolean(a.fallbackFrom) || (a.model || '').includes('(fallback)');
const modelId = (a) => (a.model || '').replace(' (fallback)', '');
const shortModel = (m) => (m && m.includes(':') ? m.slice(m.indexOf(':') + 1) : m || '–');
const provider = (m) => (m && m.includes(':') ? m.slice(0, m.indexOf(':')) : '');

function modelCell(a) {
  if (!a.model) return '<span class="muted" title="Button tap, numbered option or confirmation: handled without an LLM call">no LLM</span>';
  const m = modelId(a);
  const name = '<span class="tag">' + esc(provider(m)) + '</span> ' + esc(shortModel(m));
  if (!isBackup(a)) return name;
  const why = (a.primaryError || '').split(':').slice(0, 2).join(':').replace(/\{.*$/, '').trim();
  return name + ' <span class="tag backup">backup</span>' + (why ? '<br><span class="muted small">main model failed: ' + esc(why) + '</span>' : '');
}

function kpis(acts, info) {
  const n = (a) => acts.filter((x) => a.includes(x.action)).length;
  const lat = acts.filter((x) => x.model).map((x) => x.latencyMs).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : null;
  const items = [['Messages', acts.length], ['Invoices', n(['created', 'existing'])], ['Questions asked', n(['clarify'])], ['Ignored / replied', n(['ignore', 'respond'])], ['Main model: ' + shortModel(info.model), acts.filter((x) => x.model && !isBackup(x)).length], ['Backup model: ' + shortModel(info.fallback), acts.filter((x) => x.model && isBackup(x)).length], ['No LLM needed', acts.filter((x) => !x.model).length], ['Errors', n(['error'])], ['Median latency', p50 == null ? '–' : (p50 / 1000).toFixed(1) + ' s']];
  document.getElementById('kpis').innerHTML = items.map(([l, v]) => '<div class="kpi"><div class="v">' + esc(v) + '</div><div class="l">' + esc(l) + '</div></div>').join('');
}

function activity(acts) {
  const el = document.getElementById('activity');
  if (!acts.length) { el.innerHTML = '<tr><td class="empty">No messages yet. Send one in an allowed chat.</td></tr>'; return; }
  el.innerHTML = '<tr><th>Time</th><th>Result</th><th>Model</th><th>Customer</th><th>Items</th><th>Invoice</th><th>Why</th><th>Latency</th></tr>' + acts.map((a) => {
    const cust = a.customer ? (a.customer.name ? esc(a.customer.name) : '<span class="clarify">' + esc(a.customer.query) + ' (' + esc(a.customer.status) + ')</span>') : '<span class="muted">–</span>';
    const lines = a.lines.map((l) => (l.item ? esc(l.item) + (l.score != null ? ' <span class="muted small">' + l.score + '</span>' : '') : '<span class="clarify">' + esc(l.description ?? '?') + ' (' + esc(l.status) + ')</span>') + ' <span class="muted">× ' + esc(l.quantity ?? '?') + ' @ ' + (l.rate == null ? '?' : money(l.rate)) + '</span>').join('<br>') || '<span class="muted">–</span>';
    const inv = a.invoice ? esc(a.invoice.number) + '<br><span class="small">' + money(a.invoice.total) + ' · ' + esc(a.invoice.status) + '</span>' : '<span class="muted">–</span>';
    const why = [a.reason, ...(a.problems || [])].filter((v, i, s) => v && s.indexOf(v) === i).map(esc).join(', ') + (a.error ? '<br><span class="error small">' + esc(a.error) + '</span>' : '') + (a.text ? '<pre class="muted small">' + esc(a.text) + '</pre>' : '');
    return '<tr><td class="muted">' + time(a.at) + '</td><td class="a ' + esc(a.action) + '">' + esc(label[a.action] || a.action) + '</td><td class="small">' + modelCell(a) + '</td><td>' + cust + '</td><td>' + lines + '</td><td>' + inv + '</td><td class="small">' + why + '</td><td class="muted">' + (a.latencyMs / 1000).toFixed(1) + ' s</td></tr>';
  }).join('');
}

function pending(ps) {
  const el = document.getElementById('pending');
  el.innerHTML = ps.length ? ps.map((p) => '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><pre>' + esc(p.question) + '</pre><div class="muted small">round ' + p.attempts + ' · expires ' + time(p.expiresAt) + '</div></div>').join('') : '<div class="empty">None waiting.</div>';
}

function evaluation(ev) {
  const block = (title, runs) => {
    if (!runs.length) return '<p class="muted">' + esc(title) + ': not run yet (<code>npm run eval</code>).</p>';
    runs.sort((a, b) => a.model.localeCompare(b.model));
    const rows = [['Action accuracy', (r) => pct(r.headline.action_accuracy)], ['Customer match', (r) => pct(r.headline.customer_match_accuracy)], ['Item match', (r) => pct(r.headline.item_match_accuracy)], ['Clarification recall', (r) => pct(r.headline.clarification_recall)], ['Unnecessary clarifications', (r) => pct(r.headline.unnecessary_clarification_rate)], ['Confidently wrong invoices', (r) => '<b>' + r.headline.confidently_wrong_invoices + '</b>'], ['Non-invoice false positives', (r) => pct(r.headline.non_invoice_false_positives)], ['Latency p50 / p95', (r) => r.latency.p50 == null ? '–' : r.latency.p50 + ' / ' + r.latency.p95 + ' ms'], ['Cases scored', (r) => r.casesScored + '/' + r.caseCount]];
    return '<h2 style="margin-top:6px">' + esc(title) + '</h2><table><tr><th>Metric</th>' + runs.map((r) => '<th>' + esc(r.model) + '</th>').join('') + '</tr>' + rows.map(([l, f]) => '<tr><td>' + l + '</td>' + runs.map((r) => '<td>' + f(r) + '</td>').join('') + '</tr>').join('') + '</table>';
  };
  document.getElementById('eval').innerHTML = block('Main set (50 cases)', ev.main) + block('Held-out set', ev.holdout);
}

async function refresh() {
  try {
    const [info, acts, ps] = await Promise.all([get('/api/info'), get('/api/activity'), get('/api/pending')]);
    document.getElementById('info').innerHTML = Object.entries(info).map(([k, v]) => '<span class="chip">' + esc(k) + ': <b>' + esc(v) + '</b></span>').join(' ');
    kpis(acts, info); activity(acts); pending(ps);
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch { document.getElementById('updated').textContent = 'bot not reachable'; }
}
const loadEval = () => get('/api/eval').then(evaluation).catch(() => {});
loadEval();
setInterval(loadEval, 30000);
refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;
