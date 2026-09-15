import { normalize, select, csv, londonWall } from './data.js';
const $ = id => document.getElementById(id);
let readings = [], selection = null, sample = false, busy = false, generation = 0;
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
async function message(type, body = {}) {
  let response;
  try { response = await fetch(`/api/${type}`, type === 'session' ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Water-Ledger': '1' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(100000) }); }
  catch { throw new Error('Could not reach this server. Check your connection and try again.'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('The server did not return a valid response. Try again later.'); }
  if (!response.ok || !result?.ok) throw new Error(result?.error || 'The request failed. Please try again.');
  return result;
}
function clear() { readings = []; selection = null; sample = false; generation++; $('preview').hidden = true; $('empty').hidden = false; $('demo-badge').hidden = true; $('meter').replaceChildren(new Option('All available meters', '')); $('download').disabled = true; }
function downloadState() { $('download').disabled = busy || !selection?.rows.length || (selection.missing > 0 && !$('partial').checked); }
function render() {
  $('partial').checked = false;
  try {
    selection = select(readings, $('start').value, $('end').value, $('meter').value);
    $('empty').hidden = true; $('preview').hidden = false;
    $('total').textContent = selection.total.toLocaleString('en-GB', { maximumFractionDigits: 2 });
    $('count').textContent = selection.rows.length.toLocaleString('en-GB');
    $('coverage').textContent = !selection.rows.length ? 'No readings in this date range. Choose dates within the available history.' : selection.missing ? `${selection.missing.toLocaleString('en-GB')} expected meter-hours are missing. Missing hours are left out, never filled with zero.` : 'Every expected hour is present for the selected meters.';
    $('partial-label').hidden = !selection.missing || !selection.rows.length;
    $('rows').replaceChildren(...selection.rows.slice(0, 12).map(row => {
      const tr = document.createElement('tr');
      for (const value of [londonWall(row.start).replace('T', ' ').slice(0, 16), row.meter, row.litres.toLocaleString('en-GB')]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      return tr;
    }));
    $('preview-note').textContent = `Showing the first ${Math.min(12, selection.rows.length)} readings. CSV includes all ${selection.rows.length}, with UTC timestamps to distinguish clock changes.`;
    downloadState();
  } catch (error) { selection = null; $('download').disabled = true; status(error.message, true); }
}
function receive(payload) {
  readings = normalize(payload);
  $('meter').replaceChildren(new Option('All available meters', ''), ...[...new Set(readings.map(r => r.meter))].map(m => new Option(m, m)));
  if (!readings.length) { clear(); status('Anglian Water returned no hourly readings. Check that this account has a smart meter.'); return; }
  render();
  if (selection) status(`${sample ? 'Sample' : 'Available'} history: ${londonWall(readings[0].start).slice(0, 10)} to ${londonWall(readings.at(-1).start).slice(0, 10)}. ${sample ? 'These are fictional readings.' : 'Dates outside this history cannot be recovered by this export.'}`);
}
async function refresh() {
  try {
    const result = await message('session');
    $('badge').textContent = { connected: 'Connected', mfa: 'Verify email', disconnected: 'Not connected' }[result.status];
    $('load').disabled = busy || result.status !== 'connected';
    $('disconnect').hidden = result.status === 'disconnected';
    $('login-form').hidden = result.status !== 'disconnected';
    $('mfa-form').hidden = result.status !== 'mfa';
    if (result.status === 'disconnected' && readings.length && !sample) { clear(); status('Disconnected. Readings cleared from this page.'); }
  } catch (e) { status(e.message, true); }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); clear(); $('connect').disabled = true; status('Signing in securely with Anglian Water…');
  let password = $('password').value; $('password').value = '';
  try { const result = await message('login', { username: $('username').value, password, account: $('account').value }); status(result.status === 'mfa' ? 'Enter the verification code sent by Anglian Water.' : 'Connected. Choose your dates and load your readings.'); await refresh(); if (result.status === 'mfa') $('code').focus(); }
  catch (e) { status(e.message, true); }
  finally { password = ''; $('connect').disabled = false; }
});
$('mfa-form').addEventListener('submit', async event => {
  event.preventDefault(); $('verify').disabled = true; status('Verifying your code…');
  try { await message('mfa', { code: $('code').value }); $('code').value = ''; await refresh(); status('Connected. Choose your dates and load your readings.'); }
  catch(e) { status(e.message, true); } finally { $('verify').disabled = false; }
});
$('disconnect').addEventListener('click', async () => { clear(); $('password').value = ''; $('username').value = ''; $('account').value = ''; $('code').value = ''; try { await message('logout'); await refresh(); status('Signed out. Your server session and displayed readings have been cleared.'); } catch(e) { status(e.message, true); } });
$('load').addEventListener('click', async () => {
  clear(); const request = generation; busy = true; $('load').disabled = true; status('Loading hourly readings from Anglian Water…');
  try { const result = await message('readings'); if (request === generation) receive(result.data); } catch (e) { if (request === generation) status(e.message, true); }
  finally { busy = false; downloadState(); await refresh(); }
});
$('demo').addEventListener('click', () => {
  clear(); sample = true; $('demo-badge').hidden = false; $('start').value = '2026-09-01'; $('end').value = '2026-09-07';
  const records = []; let cumulative = 120;
  for (let i = 0; i < 168; i++) { const consumption = [0, 0, 0, 1, 0, 2, 9, 26, 18, 5, 3, 4, 8, 2, 1, 3, 6, 22, 19, 12, 6, 3, 1, 0][i % 24]; cumulative += consumption / 1000; records.push({ meters: [{ meter_serial_number: 'DEMO-001', read_at: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 3600000).toISOString(), consumption, read: +cumulative.toFixed(3) }] }); }
  receive({ result: { records } });
});
for (const id of ['start', 'end', 'meter']) $(id).addEventListener('change', () => { status(''); if (readings.length) render(); });
$('partial').addEventListener('change', downloadState);
$('download').addEventListener('click', () => {
  if ($('download').disabled || !selection) return;
  const blob = new Blob([csv(selection.rows)], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `${sample ? 'SAMPLE-' : ''}anglian-water-hourly-${$('start').value}-to-${$('end').value}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  status(`${sample ? 'Sample CSV' : 'CSV'} download started — ${selection.rows.length} readings${selection.missing ? ', incomplete coverage' : ''}.`);
});
const yesterday = new Date(Date.now() - 86400000); $('end').value = londonWall(yesterday.getTime()).slice(0, 10); $('start').value = londonWall(yesterday.getTime() - 6 * 86400000).slice(0, 10);
window.addEventListener('focus', refresh);
setInterval(refresh, 30000);
await refresh();
