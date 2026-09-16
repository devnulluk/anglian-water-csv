import { csv, summarize } from './data.js';

export const resolutions = ['hourly', 'daily', 'monthly'];

export function exportFiles(datasets, sample = false, created = new Date().toISOString()) {
  const files = {};
  const notes = [
    'Water Ledger — all available usage', `Created: ${created}`,
    sample ? 'SAMPLE: fictional data, not account readings.' : 'Provider-reported usage; no date filter was applied.', '',
    'Each resolution is requested separately from Anglian Water. Daily and monthly totals are not calculated from hourly data.',
    'Ranges below describe returned records, not a guarantee that the provider has no older history.',
    'Missing periods are omitted, never replaced with zero. A failed or empty dataset has a header-only CSV.',
    'Meter labels are anonymous and consistent across these three files, but may change in a later export.',
    'Hourly intervals end at source_read_at. Daily/monthly source_read_at is preserved exactly as reported; no assumed period boundaries or timezone shifts are applied.',
    'Blank cumulative_read_m3 means the provider omitted it. Do not add the three resolutions together: their time periods overlap.', '',
  ];
  for (const resolution of resolutions) {
    const dataset = datasets[resolution] ?? { status: 'error', error: 'Not fetched.', rows: [] };
    const rows = dataset.rows ?? [];
    files[`${resolution}.csv`] = csv(rows, resolution);
    const summary = summarize(rows, resolution);
    notes.push(`${resolution.toUpperCase()}: ${dataset.status === 'error' ? 'FAILED' : rows.length ? 'OK' : 'NO DATA'}`);
    if (dataset.status === 'error') notes.push(dataset.error);
    notes.push(`Rows: ${summary.count}`);
    if (rows.length) notes.push(`First: ${summary.first}`, `Last: ${summary.last}`, `Missing periods within each meter's returned range: ${summary.missing}`);
    notes.push('');
  }
  files['README.txt'] = notes.join('\r\n') + '\r\n';
  return files;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Standard ZIP STORE entries: no dependency, network call, or server-side file.
export function zip(files) {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, text]) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid archive filename.');
    const data = encoder.encode(text);
    return { name: encoder.encode(name), data, crc: crc32(data) };
  });
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  if (entries.length > 65535 || localSize + centralSize + 22 > 0xffffffff) throw new Error('Archive is too large.');
  const out = new Uint8Array(localSize + centralSize + 22), view = new DataView(out.buffer);
  let offset = 0;
  const u16 = (at, value) => view.setUint16(at, value, true);
  const u32 = (at, value) => view.setUint32(at, value, true);
  for (const entry of entries) {
    entry.offset = offset;
    u32(offset, 0x04034b50); u16(offset + 4, 20); u16(offset + 6, 0x800);
    u16(offset + 12, 0x21); // 1980-01-01; export creation time is in README.
    u32(offset + 14, entry.crc); u32(offset + 18, entry.data.length); u32(offset + 22, entry.data.length);
    u16(offset + 26, entry.name.length);
    out.set(entry.name, offset + 30); out.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  for (const entry of entries) {
    u32(offset, 0x02014b50); u16(offset + 4, 20); u16(offset + 6, 20); u16(offset + 8, 0x800);
    u16(offset + 14, 0x21); u32(offset + 16, entry.crc);
    u32(offset + 20, entry.data.length); u32(offset + 24, entry.data.length);
    u16(offset + 28, entry.name.length); u32(offset + 42, entry.offset);
    out.set(entry.name, offset + 46); offset += 46 + entry.name.length;
  }
  u32(offset, 0x06054b50); u16(offset + 8, entries.length); u16(offset + 10, entries.length);
  u32(offset + 12, centralSize); u32(offset + 16, localSize);
  return out;
}
