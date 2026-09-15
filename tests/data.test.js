import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, range, select, csv, timestamp } from '../static/data.js';
const meter = (at, consumption = 0, serial = 'M1') => ({ meter_serial_number: serial, read_at: at, consumption, read: 123.456 });
const payload = (...meters) => ({ result: { records: meters.map(m => ({ meters: [m] })) } });

test('inclusive UK date ranges contain 23/25 hours across DST', () => {
  assert.equal(range('2026-03-29', '2026-03-29').hours, 23);
  assert.equal(range('2026-10-25', '2026-10-25').hours, 25);
  assert.equal(range('2026-09-01', '2026-09-07').hours, 168);
});
test('reading end maps to preceding hour, including midnight', () => {
  const rows = normalize(payload(meter('2026-09-02T00:00:00+01:00', 12)));
  assert.equal(select(rows, '2026-09-01', '2026-09-01').rows.length, 1);
  assert.equal(select(rows, '2026-09-02', '2026-09-02').rows.length, 0);
});
test('naive times are interpreted in London and ambiguous times fail clearly', () => {
  assert.equal(timestamp('2026-09-01T01:00:00'), Date.parse('2026-09-01T00:00:00Z'));
  assert.throws(() => timestamp('2026-10-25T01:00:00'), /ambiguous/);
  assert.throws(() => timestamp('2026-03-29T01:00:00'), /ambiguous/);
});
test('repeated autumn hour with offsets is preserved', () => {
  const rows = normalize(payload(meter('2026-10-25T01:00:00+01:00'), meter('2026-10-25T01:00:00+00:00')));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].end - rows[0].end, 3600000);
});
test('duplicate readings deduplicate per meter and conflicts fail', () => {
  const one = meter('2026-09-01T01:00:00Z', 2);
  assert.equal(normalize(payload(one, one, { ...one, meter_serial_number: 'M2' })).length, 2);
  assert.throws(() => normalize(payload(one, { ...one, consumption: 3 })), /Conflicting/);
});
test('zero remains zero, negative values are flagged, missing data is never fabricated', () => {
  const rows = normalize(payload(meter('2026-09-01T01:00:00+01:00', 0), meter('2026-09-01T02:00:00+01:00', -2)));
  const chosen = select(rows, '2026-09-01', '2026-09-01');
  assert.equal(chosen.rows[0].litres, 0);
  assert.equal(chosen.missing, 22);
  assert.match(csv(chosen.rows), /negative_consumption/);
  assert.equal(chosen.total, -2);
});
test('CSV is escaped, spreadsheet-formula safe, and includes source and UTC times', () => {
  const value = csv(normalize(payload(meter('2026-09-01T01:00:00Z', 2, '=x,"bad"'))));
  assert.match(value, /"'=x,""bad"""/);
  assert.ok(value.startsWith('\uFEFF'));
  assert.ok(value.endsWith('\r\n'));
  assert.match(value, /interval_start_utc/);
  assert.match(value, /source_read_at/);
});
test('invalid dates, readings, and non-hourly intervals are rejected', () => {
  assert.throws(() => range('2026-02-30', '2026-03-01'));
  assert.throws(() => range('2026-09-02', '2026-09-01'));
  assert.throws(() => normalize(payload(meter('2026-09-01T01:30:00Z'))), /hourly/);
  assert.throws(() => normalize(payload(meter('2026-09-01T01:00:00Z', null))), /invalid/);
  assert.throws(() => normalize({ result: { surprise: [] } }), /format/);
});
