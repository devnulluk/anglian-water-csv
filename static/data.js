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
function number(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`A reading has invalid ${label}. No values have been replaced with zero.`);
  return Number(value);
}
export function normalize(payload, resolution = 'hourly') {
  if (!['hourly', 'daily', 'monthly'].includes(resolution)) throw new Error('Unknown resolution.');
  const body = payload?.result ?? payload;
  const records = body?.records ?? body;
  if (!Array.isArray(records)) throw new Error('The usage response format has changed or this account has no smart-meter data.');
  const unique = new Map();
  const monthlyDates = new Map();
  for (const record of records) {
    if (!Array.isArray(record.meters)) throw new Error('A usage record is missing its meters.');
    for (const meter of record.meters) {
      if (meter.meter_serial_number == null || String(meter.meter_serial_number).trim() === '') throw new Error('A reading is missing its meter serial number.');
      const source = meter.read_at;
      if (typeof source !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(source)) throw new Error('Invalid source reading date.');
      const date = source.slice(0, 10);
      const dateMs = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== date) throw new Error('Invalid source reading date.');
      const end = resolution === 'hourly' ? timestamp(source) : null;
      if (resolution === 'hourly' && end % HOUR !== 0) throw new Error('A reading is not on an hourly boundary. Export stopped to avoid labelling non-hourly data as hourly.');
      const row = { meter: String(meter.meter_serial_number), source, date, start: end === null ? null : end - HOUR, end, litres: number(meter.consumption, 'consumption'), cumulative: meter.read == null ? null : number(meter.read, 'cumulative volume') };
      const key = `${row.meter}\u0000${row.end ?? row.source}`;
      if (resolution === 'monthly') {
        const monthKey = `${row.meter}\u0000${date.slice(0, 7)}`;
        const priorSource = monthlyDates.get(monthKey);
        if (priorSource && priorSource !== source) throw new Error('The provider returned multiple readings per month for one meter. Export stopped to avoid labelling weekly or daily data as monthly.');
        monthlyDates.set(monthKey, source);
      }
      const previous = unique.get(key);
      if (previous && (previous.litres !== row.litres || previous.cumulative !== row.cumulative)) throw new Error('Conflicting readings exist for the same meter and timestamp. Export stopped.');
      unique.set(key, row);
    }
  }
  return [...unique.values()].sort((a, b) => (resolution === 'hourly' ? a.start - b.start : a.source.localeCompare(b.source)) || a.meter.localeCompare(b.meter));
}
export function summarize(rows, resolution) {
  if (!rows.length) return { count: 0, total: 0, first: '', last: '', missing: 0 };
  const labels = rows.map(r => resolution === 'hourly' ? londonWall(r.start).replace('T', ' ').slice(0, 16) : resolution === 'monthly' ? r.date.slice(0, 7) : r.date).sort();
  let missing = 0;
  for (const meter of new Set(rows.map(r => r.meter))) {
    const values = [...new Set(rows.filter(r => r.meter === meter).map(r => resolution === 'hourly' ? r.start / HOUR : resolution === 'daily' ? Date.parse(`${r.date}T00:00:00Z`) / 86400000 : Number(r.date.slice(0, 4)) * 12 + Number(r.date.slice(5, 7))))].sort((a, b) => a - b);
    missing += Math.max(0, values.at(-1) - values[0] + 1 - values.length);
  }
  return { count: rows.length, total: rows.reduce((sum, r) => sum + r.litres, 0), first: labels[0], last: labels.at(-1), missing };
}
function cell(value) {
  let text = String(value);
  if (/^[\s]*[=+@-]/.test(text) && typeof value !== 'number') text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csv(rows, resolution = 'hourly') {
  const header = resolution === 'hourly'
    ? ['meter_label', 'interval_start_utc', 'interval_end_utc', 'interval_start_europe_london', 'source_read_at', 'consumption_litres', 'cumulative_read_m3', 'quality']
    : ['meter_label', 'source_read_at', 'consumption_litres', 'cumulative_read_m3', 'quality'];
  const values = rows.map(r => resolution === 'hourly'
    ? [r.meter, new Date(r.start).toISOString(), new Date(r.end).toISOString(), londonWall(r.start), r.source, r.litres, r.cumulative ?? '', r.litres < 0 ? 'negative_consumption' : 'reported']
    : [r.meter, r.source, r.litres, r.cumulative ?? '', r.litres < 0 ? 'negative_consumption' : 'reported']);
  return '\uFEFF' + [header, ...values].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
