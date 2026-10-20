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
  <section><h2>Model evaluation</h2><div class="scroll" id="eval"></div></section>
</main>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const money = (n) => n == null ? '–' : '₹' + Number(n).toLocaleString('en-IN');
const time = (t) => new Date(t).toLocaleTimeString();
const label = { created:'Invoiced', existing:'Already invoiced', edited:'Edited', dry_run:'Dry run', clarify:'Asked', respond:'Replied', ignore:'Ignored', error:'Error' };

async function get(p) { const r = await fetch(p, { cache: 'no-store' }); return r.json(); }

// Which LLM read each message. Older log rows marked the backup with a " (fallback)" suffix.
const isBackup = (a) => Boolean(a.fallbackFrom) || (a.model || '').includes('(fallback)');
const modelId = (a) => (a.model || '').replace(' (fallback)', '');
const shortModel = (m) => (m && m.includes(':') ? m.slice(m.indexOf(':') + 1) : m || '–');

// Reason codes in plain words (anything unknown falls back to the code with spaces).
const REASONS = {
  missing_customer: 'customer missing', ambiguous_customer: 'which customer?', unknown_customer: 'unknown customer',
  missing_item: 'item missing', ambiguous_item: 'which item?', unknown_item: 'unknown item',
  missing_quantity: 'quantity missing', invalid_quantity: 'invalid quantity', missing_rate: 'rate missing', invalid_rate: 'invalid rate',
  currency_mismatch: 'other currency', shared_rate: 'one rate for several items', shared_quantity: 'one quantity for several items',
  ungrounded_rate: 'rate not in message', ungrounded_quantity: 'quantity not in message',
  rate_from_previous: 'rate needed', confirm_previous_rate: 'confirm last rate', confirm_invoice: 'waiting for ✅',
  confirm_new_customer: 'confirm new customer', customer_created: 'customer added', invoice_cancelled: 'cancelled',
  non_invoice: 'not an invoice', unsupported_followup: 'not supported', idempotent_hit: 'already invoiced',
  edit_without_target: 'reply to an invoice to edit', confirmation_expired: 'confirmation expired',
};
const plain = (code) => REASONS[code] || String(code || '').replace(/_/g, ' ');

function modelCell(a) {
  if (!a.model) return '<span class="muted" title="Button tap, numbered option or confirmation: no LLM call">–</span>';
  const name = esc(shortModel(modelId(a)).replace('openai/', ''));
  if (!isBackup(a)) return name;
  const why = (a.primaryError || '').split('{')[0].trim();
  return '<span title="Main model failed: ' + esc(why) + '">' + name + ' <span class="tag backup">backup</span></span>';
}

function resultCell(a) {
  const head = '<span class="a ' + esc(a.action) + '">' + esc(label[a.action] || a.action) + '</span>';
  if (a.invoice) return head + ' <span class="small">' + esc(a.invoice.number) + ' · ' + money(a.invoice.total) + '</span>';
  if (a.action === 'error') return head + '<br><span class="small muted">' + esc((a.error || plain(a.reason)).slice(0, 80)) + '</span>';
  const why = [...new Set((a.problems && a.problems.length ? a.problems : [a.reason]).filter(Boolean).map(plain))].join(', ');
  return head + (why ? '<br><span class="small muted">' + esc(why) + '</span>' : '');
}

function detailsCell(a) {
  const cust = a.customer ? esc(a.customer.name || a.customer.query + '?') : a.invoice ? esc(a.invoice.customer) : '';
  const lines = a.lines
    .map((l) => '<span title="' + esc(l.item ? 'match score ' + (l.score ?? '') : l.status) + '">' + esc(l.item || (l.description ? l.description + '?' : 'item?')) + '</span>' + ' × ' + esc(l.quantity ?? '?') + ' @ ' + (l.rate == null ? '?' : money(l.rate)))
    .join('; ');
  const text = (a.client ? '<span class="tag">' + esc(a.client) + '</span> ' : '') + [cust, lines].filter(Boolean).join(' · ');
  return (text || '<span class="muted">–</span>') + (a.text ? '<div class="muted small">“' + esc(a.text.slice(0, 120)) + '”</div>' : '');
}

function kpis(acts, info) {
  const n = (a) => acts.filter((x) => a.includes(x.action)).length;
  const lat = acts.filter((x) => x.model).map((x) => x.latencyMs).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : null;
  const items = [
    ['Messages', acts.length],
    ['Invoices', n(['created', 'existing', 'edited'])],
    ['Questions asked', n(['clarify'])],
    ['Answered by backup', acts.filter((x) => x.model && isBackup(x)).length],
    ['Errors', n(['error'])],
    ['Median response', p50 == null ? '–' : (p50 / 1000).toFixed(1) + ' s'],
  ];
  document.getElementById('kpis').innerHTML = items.map(([l, v]) => '<div class="kpi"><div class="v">' + esc(v) + '</div><div class="l">' + esc(l) + '</div></div>').join('');
}

function activity(acts) {
  const el = document.getElementById('activity');
  if (!acts.length) { el.innerHTML = '<tr><td class="empty">No messages yet. Send one in an allowed chat.</td></tr>'; return; }
  el.innerHTML = '<tr><th>Time</th><th>Result</th><th>Details</th><th>Model</th></tr>' + acts.slice(0, 50).map((a) =>
    '<tr><td class="muted small">' + time(a.at) + '<br>' + (a.latencyMs / 1000).toFixed(1) + ' s</td><td>' + resultCell(a) + '</td><td>' + detailsCell(a) + '</td><td class="small">' + modelCell(a) + '</td></tr>',
  ).join('');
}

function pending(ps) {
  const el = document.getElementById('pending');
  el.innerHTML = ps.length ? ps.map((p) => '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><pre>' + esc(p.question) + '</pre><div class="muted small">round ' + p.attempts + ' · expires ' + time(p.expiresAt) + '</div></div>').join('') : '<div class="empty">None waiting.</div>';
}

// One row per model: the few numbers that matter. Full detail lives in eval/results/summary.md.
function evaluation(ev) {
  const el = document.getElementById('eval');
  const models = ev.main.filter((r) => r.model !== 'oracle');
  if (!models.length) { el.innerHTML = '<p class="muted">Not run yet (<code>npm run eval</code>).</p>'; return; }
  const held = Object.fromEntries(ev.holdout.map((r) => [r.model, r]));
  const name = (m) => (m === 'rules' ? 'No AI (regex baseline)' : shortModel(m).replace('openai/', ''));
  const p = (r) => (r && r.pct != null ? r.pct + '%' : '–');
  models.sort((a, b) => (b.headline.action_accuracy.pct ?? 0) - (a.headline.action_accuracy.pct ?? 0));
  el.innerHTML = '<table><tr><th>Model</th><th>Correct (50 tests)</th><th>Correct (24 unseen)</th><th>Wrong invoices</th><th>Unneeded questions</th><th>Median time</th></tr>' +
    models.map((r) => {
      const h = held[r.model];
      const wrong = r.headline.confidently_wrong_invoices + (h ? h.headline.confidently_wrong_invoices : 0);
      const t = r.model === 'rules' ? '–' : r.latency.p50 == null ? '–' : (r.latency.p50 / 1000).toFixed(1) + ' s';
      return '<tr><td>' + esc(name(r.model)) + '</td><td><b>' + p(r.headline.action_accuracy) + '</b></td><td>' + (h ? p(h.headline.action_accuracy) : '–') + '</td><td class="' + (wrong ? 'error' : 'created') + '"><b>' + wrong + '</b></td><td>' + p(r.headline.unnecessary_clarification_rate) + '</td><td>' + t + '</td></tr>';
    }).join('') + '</table><p class="muted small">Full per-field results: <code>eval/results/summary.md</code></p>';
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
