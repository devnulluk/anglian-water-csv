import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFiles, zip } from '../static/archive.js';
import { normalize } from '../static/data.js';
const rows = normalize({records: [{meters: [{meter_serial_number: 'Meter 1', read_at: '2024-09-01', consumption: 42, read: null}]}]}, 'monthly');

test('archive always contains three CSVs and explicit failure/empty notes', () => {
  const files = exportFiles({hourly: {status:'error',error:'Request failed.',rows:[]},daily: {status:'ok',rows:[]},monthly:{status:'ok',rows}}, false, '2026-09-19T00:00:00Z');
  assert.deepEqual(Object.keys(files), ['hourly.csv', 'daily.csv', 'monthly.csv', 'README.txt']);
  assert.match(files['README.txt'], /HOURLY: FAILED/); assert.match(files['README.txt'], /DAILY: NO DATA/);
  assert.match(files['README.txt'], /MONTHLY: OK/); assert.match(files['monthly.csv'], /2024-09-01/);
});
test('ZIP headers, central directory and CRC match a known entry', () => {
  const bytes = zip({'a.txt':'123456789'}), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0,true),0x04034b50);
  assert.equal(view.getUint32(14,true),0xcbf43926);
  const end = bytes.length-22, central = view.getUint32(end+16,true);
  assert.equal(view.getUint32(central,true),0x02014b50);
  assert.equal(view.getUint32(end,true),0x06054b50);
  assert.equal(view.getUint16(end+10,true),1);
  assert.equal(view.getUint32(central+42,true),0);
  assert.equal(new TextDecoder().decode(bytes.slice(35,44)),'123456789');
});
test('ZIP encodes Unicode content as UTF-8 and rejects unsafe names', () => {
  const bytes=zip({'README.txt':'Water — £'});
  assert.ok(new TextDecoder().decode(bytes).includes('Water — £'));
  assert.throws(() => zip({'../secret':'x'}), /filename/);
});
