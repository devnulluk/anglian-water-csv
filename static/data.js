const HOUR = 3600000;
const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function londonWall(ms) {
  const p = Object.fromEntries(formatter.formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
export function timestamp(value) {
  if (typeof value !== 'string') throw new Error('A reading has no timestamp.');
  const datePart = value.slice(0, 10);
  const dateMs = Date.parse(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== datePart) throw new Error('Invalid reading date.');
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const result = Date.parse(value);
    if (Number.isFinite(result)) return result;
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value)) throw new Error('Unsupported reading timestamp.');
  const wall = value.length === 16 ? `${value}:00` : value;
  const utc = Date.parse(`${wall}Z`);
  const candidates = [utc - HOUR, utc].filter(ms => Number.isFinite(ms) && londonWall(ms) === wall);
  if (candidates.length !== 1) throw new Error(`The timestamp ${value} is ambiguous or invalid during a UK clock change. An explicit UTC offset is needed to export safely.`);
  return candidates[0];
}
export function range(start, end) {
  for (const value of [start, end]) {
    if (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Choose valid start and end dates.');
  }
  if (start > end) throw new Error('The end date must be on or after the start date.');
  const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const from = timestamp(`${start}T00:00:00`), to = timestamp(`${next}T00:00:00`);
  if (to - from > 366 * 86400000 + HOUR) throw new Error('Choose a date range of up to one year.');
  return { from, to, hours: (to - from) / HOUR };
}
function number(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`A reading has invalid ${label}. No values have been replaced with zero.`);
  return Number(value);
}
export function normalize(payload) {
  const body = payload?.result ?? payload;
  const records = body?.records ?? body;
  if (!Array.isArray(records)) throw new Error('The usage response format has changed or this account has no smart-meter data.');
  const unique = new Map();
  for (const record of records) {
    if (!Array.isArray(record.meters)) throw new Error('A usage record is missing its meters.');
    for (const meter of record.meters) {
      if (meter.meter_serial_number == null || String(meter.meter_serial_number).trim() === '') throw new Error('A reading is missing its meter serial number.');
      const end = timestamp(meter.read_at);
      if (end % HOUR !== 0) throw new Error('A reading is not on an hourly boundary. Export stopped to avoid labelling non-hourly data as hourly.');
      const row = { meter: String(meter.meter_serial_number), source: meter.read_at, start: end - HOUR, end, litres: number(meter.consumption, 'consumption'), cumulative: number(meter.read, 'cumulative volume') };
      const key = `${row.meter}\u0000${row.end}`;
      const previous = unique.get(key);
      if (previous && (previous.litres !== row.litres || previous.cumulative !== row.cumulative)) throw new Error('Conflicting readings exist for the same meter and hour. Export stopped.');
      unique.set(key, row);
    }
  }
  return [...unique.values()].sort((a, b) => a.start - b.start || a.meter.localeCompare(b.meter));
}
export function select(rows, start, end, meter = '') {
  const bounds = range(start, end);
  const meters = [...new Set(rows.map(r => r.meter))].filter(m => !meter || m === meter);
  const chosen = rows.filter(r => r.start >= bounds.from && r.start < bounds.to && (!meter || r.meter === meter));
  const missing = Math.max(0, bounds.hours * meters.length - chosen.length);
  return { rows: chosen, missing, expected: bounds.hours * meters.length, total: chosen.reduce((sum, r) => sum + r.litres, 0) };
}
function cell(value) {
  let text = String(value);
  if (/^[\s]*[=+@-]/.test(text) && typeof value !== 'number') text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csv(rows) {
  const header = ['meter_label', 'interval_start_utc', 'interval_end_utc', 'interval_start_europe_london', 'source_read_at', 'consumption_litres', 'cumulative_read_m3', 'quality'];
  return '\uFEFF' + [header, ...rows.map(r => [r.meter, new Date(r.start).toISOString(), new Date(r.end).toISOString(), londonWall(r.start), r.source, r.litres, r.cumulative, r.litres < 0 ? 'negative_consumption' : 'reported'])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
