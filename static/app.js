import { normalize, summarize, londonWall } from './data.js';
import { readResponse } from './api.js';
import { resolutions, exportFiles, zip } from './archive.js';
const $ = id => document.getElementById(id);
let datasets = null, sample = false, busy = false, generation = 0;
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
async function message(type, body = {}) {
  let response;
  try { response = await fetch(`/api/${type}`, type === 'session' ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Water-Ledger': '1' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(100000) }); }
  catch { throw new Error('Could not reach this server. Check your connection and try again.'); }
  return readResponse(response);
}
function clear() {
  datasets = null; sample = false; generation++;
  $('preview').hidden = true; $('empty').hidden = false; $('demo-badge').hidden = true;
  $('download').disabled = true; $('partial').checked = false;
  $('rows').replaceChildren(); $('history').replaceChildren();
}
function incomplete() {
  return datasets && resolutions.some(r => datasets[r].status === 'error' || !datasets[r].rows.length || summarize(datasets[r].rows, r).missing > 0);
}
function downloadState() {
  $('download').disabled = busy || !datasets || !resolutions.some(r => datasets[r].rows.length) || (incomplete() && !$('partial').checked);
}
function render() {
  if (!datasets) return;
  $('empty').hidden = true; $('preview').hidden = false;
  $('history').replaceChildren(...resolutions.map(resolution => {
    const dataset = datasets[resolution], summary = summarize(dataset.rows, resolution);
    const div = document.createElement('div'); div.className = 'history-item';
    const title = document.createElement('strong'); title.textContent = resolution[0].toUpperCase() + resolution.slice(1);
    const detail = document.createElement('p'); detail.className = 'small';
    detail.textContent = dataset.status === 'error' ? dataset.error : summary.count ? `${summary.count.toLocaleString('en-GB')} readings · ${summary.first} to ${summary.last}${summary.missing ? ` · ${summary.missing} missing periods within returned ranges` : ''}` : 'No readings returned.';
    div.append(title, detail); return div;
  }));
  const resolution = $('resolution').value, dataset = datasets[resolution];
  const summary = summarize(dataset.rows, resolution);
  $('total').textContent = summary.total.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  $('count').textContent = summary.count.toLocaleString('en-GB');
  $('preview-heading').textContent = resolution === 'hourly' ? 'Hour starting (UK)' : 'Source reading date';
  $('coverage').textContent = dataset.status === 'error' ? dataset.error : !summary.count ? 'No readings returned for this resolution.' : resolution === 'hourly' ? 'Hourly intervals use UK time; the CSV also includes UTC and the original timestamp.' : 'Dates are shown as reported by Anglian Water. The CSV preserves the full source timestamp.';
  $('rows').replaceChildren(...dataset.rows.slice(0, 12).map(row => {
    const tr = document.createElement('tr');
    const when = resolution === 'hourly' ? londonWall(row.start).replace('T', ' ').slice(0, 16) : row.date;
    for (const value of [when, row.meter, row.litres.toLocaleString('en-GB')]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    return tr;
  }));
  $('preview-note').textContent = `Preview: first ${Math.min(12, summary.count)} ${resolution} readings. The ZIP includes all returned readings, all meters and all three resolutions.`;
  $('partial-label').hidden = !incomplete(); downloadState();
}
function receive(payload) {
  datasets = {};
  for (const resolution of resolutions) {
    const incoming = payload?.[resolution];
    try {
      if (!incoming || incoming.status !== 'ok') throw new Error(incoming?.error || 'This resolution was not returned.');
      datasets[resolution] = { status: 'ok', rows: normalize(incoming.data, resolution) };
    } catch (error) { datasets[resolution] = { status: 'error', error: error.message, rows: [] }; }
  }
  $('partial').checked = false; render();
  status(sample ? 'Fictional sample data loaded. Download the sample ZIP to see the file formats.' : incomplete() ? 'History loaded with gaps, an empty dataset or a failed request. Review the summary before downloading.' : 'All three history requests completed. Download every returned reading in one ZIP.');
}
async function refresh() {
  try {
    const result = await message('session');
    $('badge').textContent = { connected: 'Connected', mfa: 'Verify email', disconnected: 'Not connected' }[result.status];
    $('load').disabled = busy || result.status !== 'connected';
    $('disconnect').hidden = result.status === 'disconnected';
    $('login-form').hidden = result.status !== 'disconnected';
    $('mfa-form').hidden = result.status !== 'mfa';
    if (result.status === 'disconnected' && datasets && !sample) { clear(); status('Disconnected. Readings cleared from this page.'); }
  } catch (e) { status(e.message, true); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); clear(); $('connect').disabled = true; status('Signing in securely with Anglian Water…');
  let credentials = { username: $('username').value, password: $('password').value, account: $('account').value };
  for (const id of ['username', 'password', 'account']) $(id).value = '';
  try { const result = await message('login', credentials); status(result.status === 'mfa' ? 'Enter the verification code sent by Anglian Water.' : 'Connected. Load all available history.'); await refresh(); if (result.status === 'mfa') $('code').focus(); }
  catch (e) { status(e.message, true); }
  finally { credentials = null; $('connect').disabled = false; }
});
$('mfa-form').addEventListener('submit', async event => {
  event.preventDefault(); $('verify').disabled = true; status('Verifying your code…');
  let code = $('code').value; $('code').value = '';
  try { await message('mfa', { code }); await refresh(); status('Connected. Load all available history.'); }
  catch(e) { status(e.message, true); } finally { code = ''; $('verify').disabled = false; }
});
$('disconnect').addEventListener('click', async () => { clear(); for (const id of ['password', 'username', 'account', 'code']) $(id).value = ''; try { await message('logout'); await refresh(); status('Signed out. Your server session and displayed readings have been cleared.'); } catch(e) { status(e.message, true); } });
$('load').addEventListener('click', async () => {
  clear(); const request = generation; busy = true; $('load').disabled = true; $('demo').disabled = true;
  status('Requesting all available hourly, daily and monthly history…');
  try { const result = await message('readings'); if (request === generation) receive(result.datasets); }
  catch (e) { if (request === generation) status(e.message, true); }
  finally { busy = false; $('demo').disabled = false; downloadState(); await refresh(); }
});
$('demo').addEventListener('click', () => {
  clear(); sample = true; $('demo-badge').hidden = false;
  const payload = {};
  for (const resolution of resolutions) {
    const count = {hourly: 168, daily: 365, monthly: 24}[resolution];
    const records = Array.from({length: count}, (_, i) => {
      const read_at = resolution === 'hourly' ? new Date(Date.parse('2026-09-01T00:00:00Z') + i * 3600000).toISOString() : resolution === 'daily' ? new Date(Date.UTC(2025, 6, 1 + i)).toISOString().slice(0, 10) : new Date(Date.UTC(2024, 8 + i, 1)).toISOString().slice(0, 10);
      const consumption = resolution === 'hourly' ? [0, 0, 0, 1, 0, 2, 9, 26, 18, 5, 3, 4, 8, 2, 1, 3, 6, 22, 19, 12, 6, 3, 1, 0][i % 24] : resolution === 'daily' ? 150 + i % 40 : 4500 + i * 13;
      return {meters: [{meter_serial_number: 'Meter 1', read_at, consumption, read: null}]};
    });
    payload[resolution] = {status: 'ok', data: {result: {records}}};
  }
  receive(payload);
});
$('resolution').addEventListener('change', render);
$('partial').addEventListener('change', downloadState);
$('download').addEventListener('click', () => {
  if ($('download').disabled || !datasets) return;
  try {
    const blob = new Blob([zip(exportFiles(datasets, sample))], { type: 'application/zip' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${sample ? 'SAMPLE-' : ''}anglian-water-all-history.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    status(`${sample ? 'Sample ZIP' : 'ZIP'} download started. Includes hourly.csv, daily.csv, monthly.csv and a coverage report.`);
  } catch(e) { status(e.message, true); }
});
window.addEventListener('pagehide', () => { for (const id of ['username', 'password', 'account', 'code']) $(id).value = ''; });
window.addEventListener('focus', refresh);
setInterval(refresh, 30000);
await refresh();
