import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, summarize, csv, timestamp } from '../static/data.js';
const meter = (at, consumption = 0, serial = 'M1') => ({ meter_serial_number: serial, read_at: at, consumption, read: 123.456 });
const payload = (...meters) => ({ result: { records: meters.map(m => ({ meters: [m] })) } });

test('hourly reading end maps to preceding hour, including midnight', () => {
  const rows = normalize(payload(meter('2026-09-02T00:00:00+01:00', 12)));
  assert.equal(new Date(rows[0].start).toISOString(), '2026-09-01T22:00:00.000Z');
  assert.equal(summarize(rows, 'hourly').first, '2026-09-01 23:00');
});
test('naive times use London and ambiguous times fail clearly', () => {
  assert.equal(timestamp('2026-09-01T01:00:00'), Date.parse('2026-09-01T00:00:00Z'));
  assert.throws(() => timestamp('2026-10-25T01:00:00'), /ambiguous/);
  assert.throws(() => timestamp('2026-03-29T01:00:00'), /ambiguous/);
});
test('repeated autumn hour and spring gap do not invent missing hours', () => {
  const autumn = normalize(payload(meter('2026-10-25T01:00:00+01:00'), meter('2026-10-25T01:00:00+00:00')));
  assert.equal(autumn.length, 2);
  assert.equal(summarize(autumn, 'hourly').missing, 0);
  const spring = normalize(payload(meter('2026-03-29T01:00:00Z'), meter('2026-03-29T03:00:00+01:00')));
  assert.equal(summarize(spring, 'hourly').missing, 0);
});
test('duplicate readings deduplicate per meter and conflicts fail', () => {
  const one = meter('2026-09-01T01:00:00Z', 2);
  assert.equal(normalize(payload(one, one, { ...one, meter_serial_number: 'M2' })).length, 2);
  assert.throws(() => normalize(payload(one, { ...one, consumption: 3 })), /Conflicting/);
});
test('zero and negative values remain; gaps counted only within each meter history', () => {
  const rows = normalize(payload(meter('2026-09-01T01:00:00Z', 0), meter('2026-09-01T03:00:00Z', -2), meter('2026-09-04T01:00:00Z', 5, 'M2')));
  assert.equal(rows[0].litres, 0);
  assert.equal(summarize(rows, 'hourly').missing, 1);
  assert.match(csv(rows), /negative_consumption/);
  assert.equal(summarize(rows, 'hourly').total, 3);
});
test('CSV is quoted, formula-safe and retains source timestamps', () => {
  const value = csv(normalize(payload(meter('2026-09-01T01:00:00Z', 2, '=x,"bad"'))));
  assert.match(value, /"'=x,""bad"""/);
  assert.ok(value.startsWith('\uFEFF')); assert.ok(value.endsWith('\r\n'));
  assert.match(value, /interval_start_utc/); assert.match(value, /source_read_at/);
});
test('daily and monthly histories retain dates without shifting or one-year cap', () => {
  for (const resolution of ['daily', 'monthly']) {
    const rows = normalize(payload(meter('2024-09-01'), {...meter('2026-06-30T00:00:00+01:00'), read: null}), resolution);
    assert.equal(rows.length, 2); assert.equal(rows[0].source, '2024-09-01');
    assert.equal(rows[1].source, '2026-06-30T00:00:00+01:00');
    const output = csv(rows, resolution);
    assert.match(output, /2024-09-01/); assert.doesNotMatch(output, /interval_start/);
    assert.match(output, /"0","","reported"/);
  }
});
test('daily/monthly gap counts use calendar periods, including leap years', () => {
  assert.equal(summarize(normalize(payload(meter('2024-02-28'), meter('2024-03-01')), 'daily'), 'daily').missing, 1);
  assert.equal(summarize(normalize(payload(meter('2024-12-01'), meter('2025-02-01')), 'monthly'), 'monthly').missing, 1);
});
test('empty histories have no invented range or readings', () => {
  assert.deepEqual(summarize([], 'daily'), {count: 0, total: 0, first: '', last: '', missing: 0});
  assert.equal(csv([], 'monthly').split('\r\n').length, 2);
});
test('invalid dates, values and non-hourly boundaries are rejected', () => {
  assert.throws(() => normalize(payload(meter('2026-02-30')), 'daily'), /date/);
  assert.throws(() => normalize(payload(meter('2026-09-01T01:30:00Z'))), /hourly/);
  assert.throws(() => normalize(payload(meter('2026-09-01T01:00:00Z', null))), /invalid/);
  assert.throws(() => normalize({ result: { surprise: [] } }), /format/);
});
