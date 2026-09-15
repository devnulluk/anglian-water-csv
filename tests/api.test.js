import test from 'node:test';
import assert from 'node:assert/strict';
import { readResponse } from '../static/api.js';

test('proxy HTML errors give useful status without exposing the body', async () => {
  await assert.rejects(readResponse(new Response('<html>PRIVATE</html>', {status: 502})), /gateway.*HTTP 502/);
});
test('safe application dependency errors are preserved', async () => {
  await assert.rejects(readResponse(Response.json({ok: false, error: 'Could not reach Anglian Water.'}, {status: 424})), {message: 'Could not reach Anglian Water.'});
});
test('successful login state reaches the caller', async () => {
  assert.deepEqual(await readResponse(Response.json({ok: true, status: 'mfa'})), {ok: true, status: 'mfa'});
});
