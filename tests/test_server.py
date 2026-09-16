import asyncio
import time

import aiohttp
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

import server

ORIGIN = 'https://water.devnull.co.uk'
HEADERS = {'Origin': ORIGIN, 'X-Water-Ledger': '1'}

class FakeAuth:
    def __init__(self, username, password, session):
        self.username = username
        self._password = password
        self.auth_data = None
        self._refresh_token = 'fake-refresh'
        self.http = session
        self.access_token = None

    async def send_login_request(self):
        if self.username == 'mfa@example.test':
            raise server.aw_errors.MFARequiredError(readonly_email=self.username)
        if self.username == 'bad@example.test':
            raise server.aw_errors.SelfAssertedError('secret-password must not appear')
        self.access_token = 'fake-access'

    async def send_mfa_request(self, code):
        if code != '123456':
            raise server.aw_errors.MFARequiredError(readonly_email=self.username)
        self.access_token = 'fake-access'

@pytest_asyncio.fixture
async def client():
    app = server.create_app(origin=ORIGIN, secure=False, auth_factory=FakeAuth)
    async with TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
        yield client

async def login(client, username='person@example.test'):
    return await client.post('/api/login', headers=HEADERS, json={'username': username, 'password': 'secret-password', 'account': '123456789'})

@pytest.mark.asyncio
async def test_login_cookie_password_disposal_and_logout(client):
    response = await login(client)
    assert response.status == 200
    assert response.cookies[server.COOKIE]['httponly']
    assert response.cookies[server.COOKIE]['samesite'] == 'Strict'
    item = next(iter(client.app[server.STORE].values()))
    assert item.auth._password == ''
    assert (await (await client.get('/api/session')).json())['status'] == 'connected'
    assert 'secret' not in await response.text()
    await client.post('/api/logout', headers=HEADERS, json={})
    assert item.http.closed
    assert not client.app[server.STORE]
    assert (await client.post('/api/readings', headers=HEADERS, json={})).status == 401

@pytest.mark.asyncio
async def test_mfa_and_invalid_code_recovery(client):
    response = await login(client, 'mfa@example.test')
    assert (await response.json())['status'] == 'mfa'
    assert next(iter(client.app[server.STORE].values())).auth._password == ''
    assert (await client.post('/api/readings', headers=HEADERS, json={})).status == 401
    assert (await client.post('/api/mfa', headers=HEADERS, json={'code': '000000'})).status == 401
    response = await client.post('/api/mfa', headers=HEADERS, json={'code': '123456'})
    assert (await response.json())['status'] == 'connected'

@pytest.mark.asyncio
async def test_wrong_origin_no_header_and_validation(client):
    for headers in [{}, {'Origin': 'https://evil.test', 'X-Water-Ledger': '1'}, {'Origin': ORIGIN}]:
        assert (await client.post('/api/login', headers=headers, json={})).status == 403
    assert (await client.post('/api/login', headers=HEADERS, json=[])).status == 400
    assert (await client.post('/api/login', headers=HEADERS, json={'username': 'a', 'password': 'b', 'account': '../bad'})).status == 400
    assert not client.app[server.STORE]

@pytest.mark.asyncio
async def test_no_secret_in_errors_and_no_session_after_failure(client):
    response = await login(client, 'bad@example.test')
    assert response.status == 401
    assert 'secret-password' not in await response.text()
    assert not client.app[server.STORE]

@pytest.mark.asyncio
async def test_expired_session_is_closed(client):
    await login(client)
    item = next(iter(client.app[server.STORE].values()))
    item.expires = time.monotonic() - 1
    assert (await (await client.get('/api/session')).json())['status'] == 'disconnected'
    assert item.http.closed

@pytest.mark.asyncio
async def test_users_are_isolated_and_only_hourly_endpoint_is_used(client, monkeypatch):
    calls = []
    async def send(api, endpoint, body, account, **kwargs):
        calls.append((endpoint, account, kwargs))
        return {'result': {'records': []}}
    monkeypatch.setattr(server.API, 'send_request', send)
    await login(client)
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as other:
        assert (await other.post(client.make_url('/api/readings'), headers=HEADERS, json={})).status == 401
        assert (await (await other.get(client.make_url('/api/session'))).json())['status'] == 'disconnected'
    response = await client.post('/api/readings', headers=HEADERS, json={})
    assert response.status == 200
    assert calls == [('get_usage_details', '123456789', {'GRANULARITY': f}) for f in ('10', '20', '40')]
    assert set((await response.json())['datasets']) == {'hourly', 'daily', 'monthly'}
    assert (await client.post('/api/readings', headers=HEADERS, json={})).status == 429

@pytest.mark.asyncio
async def test_no_store_csp_and_no_source_exposure(client):
    for path in ['/', '/app.js', '/health', '/api/session', '/server.py', '/.env']:
        response = await client.get(path)
        assert response.headers['Cache-Control'] == 'no-store'
        assert "frame-ancestors 'none'" in response.headers['Content-Security-Policy']
        if path in ['/server.py', '/.env']:
            assert response.status == 404

@pytest.mark.asyncio
async def test_logout_suppresses_inflight_readings(client, monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    async def send(*args, **kwargs):
        started.set()
        await release.wait()
        return {'private': 'data'}
    monkeypatch.setattr(server.API, 'send_request', send)
    await login(client)
    loading = asyncio.create_task(client.post('/api/readings', headers=HEADERS, json={}))
    await started.wait()
    logout = asyncio.create_task(client.post('/api/logout', headers=HEADERS, json={}))
    for _ in range(20):
        if not client.app[server.STORE]:
            break
        await asyncio.sleep(.01)
    release.set()
    response = await loading
    assert response.status == 401
    assert 'private' not in await response.text()
    assert (await logout).status == 200

def test_origin_validation():
    with pytest.raises(ValueError):
        server.create_app(origin='https://example.test/path')

@pytest.mark.asyncio
async def test_mfa_attempt_limit(client):
    await login(client, 'mfa@example.test')
    for _ in range(5):
        assert (await client.post('/api/mfa', headers=HEADERS, json={'code': '000000'})).status == 401
    assert (await client.post('/api/mfa', headers=HEADERS, json={'code': '123456'})).status == 429

@pytest.mark.asyncio
async def test_https_session_cookie_is_secure():
    app = server.create_app(origin=ORIGIN, auth_factory=FakeAuth)
    async with TestClient(TestServer(app)) as client:
        response = await login(client)
        assert response.cookies[server.COOKIE]['secure']

@pytest.mark.asyncio
async def test_usage_response_removes_identity_metadata(client, monkeypatch):
    async def send(*args, **kwargs):
        return {'email': 'private@example.test', 'result': {'address': 'PRIVATE ADDRESS', 'records': [
            {'account': '999999999', 'meters': [{'meter_serial_number': 'PRIVATE-SERIAL',
              'read_at': '2026-09-01T01:00:00Z', 'consumption': '12.5', 'read': 123,
              'customer': {'name': 'PRIVATE NAME'}, 'token': 'PRIVATE TOKEN'}]}]}}
    monkeypatch.setattr(server.API, 'send_request', send)
    await login(client)
    response = await client.post('/api/readings', headers=HEADERS, json={})
    assert response.status == 200
    assert (await response.json())['datasets']['hourly']['data'] == {'result': {'records': [{'meters': [{
        'meter_serial_number': 'Meter 1', 'read_at': '2026-09-01T01:00:00Z',
        'consumption': 12.5, 'read': 123.0}]}]}}
    text = await response.text()
    assert all(value not in text for value in ['PRIVATE', '999999999', 'private@example.test'])

@pytest.mark.parametrize('field,value', [('read_at', 'private@example.test'), ('consumption', {'password': 'private'}), ('read', 'NaN')])
def test_usage_allowlist_rejects_non_usage_values(field, value):
    meter = {'meter_serial_number': 'serial', 'read_at': '2026-09-01T01:00:00Z', 'consumption': 1, 'read': 2}
    meter[field] = value
    with pytest.raises((ValueError, TypeError)):
        server.usage_only({'records': [{'meters': [meter]}]})

@pytest.mark.asyncio
async def test_auth_minimization_and_complete_disposal():
    async with aiohttp.ClientSession() as http:
        auth = server.PrivateAuth('private@example.test', 'password', session=http)
        auth.auth_data = {'access_token': 'needed', 'refresh_token': 'needed-refresh',
            'extension_business_partner_number': 'needed-partner', 'name': 'PRIVATE', 'id_token': 'PRIVATE'}
        auth._cookie_cache['secret'] = 'PRIVATE'
        http.cookie_jar.update_cookies({'upstream-secret': 'PRIVATE'})
        auth.minimize()
        assert set(auth.auth_data) == {'access_token', 'refresh_token', 'extension_business_partner_number'}
        assert auth.username == auth._password == ''
        assert not auth._cookie_cache and not http.cookie_jar
        item = server.Session(http, auth, '123456789')
        await item.close()
        assert item.account == '' and http.closed
        assert auth.__dict__ == {'_password': '', 'auth_data': None, '_refresh_token': None}

@pytest.mark.asyncio
async def test_provider_cookie_values_are_not_quoted(client):
    await login(client)
    item = next(iter(client.app[server.STORE].values()))
    from yarl import URL
    url = URL('https://login.example.test/')
    item.http.cookie_jar.update_cookies({'provider-session': 'value/with=padding'}, response_url=url)
    cookie = item.http.cookie_jar.filter_cookies(url)['provider-session']
    assert cookie.coded_value == 'value/with=padding'

@pytest.mark.asyncio
async def test_upstream_errors_preserve_safe_json(client, monkeypatch):
    async def fail(auth):
        raise aiohttp.ClientConnectionError('PRIVATE upstream connection detail')
    monkeypatch.setattr(FakeAuth, 'send_login_request', fail)
    response = await login(client)
    assert response.status == 424
    assert response.content_type == 'application/json'
    assert (await response.json())['error'] == 'Could not reach Anglian Water. Please try again later.'
    assert not client.app[server.STORE]


@pytest.mark.asyncio
async def test_independent_histories_and_consistent_anonymous_labels(client, monkeypatch):
    async def send(api, endpoint, body, account, **kwargs):
        frequency = kwargs['GRANULARITY']
        # Same meters arrive in a different order, with much older monthly data.
        serials = ['PRIVATE-A', 'PRIVATE-B'] if frequency == '10' else ['PRIVATE-B', 'PRIVATE-A']
        date = {'10': '2026-06-30T01:00:00Z', '20': '2025-07-01', '40': '2024-09-01'}[frequency]
        return {'records': [{'meters': [{'meter_serial_number': serial, 'read_at': date,
            'consumption': 20, 'private': 'PRIVATE'} for serial in serials]}]}
    monkeypatch.setattr(server.API, 'send_request', send)
    await login(client)
    response = await client.post('/api/readings', headers=HEADERS, json={})
    data = (await response.json())['datasets']
    assert all(item['status'] == 'ok' for item in data.values())
    assert data['hourly']['data']['result']['records'][0]['meters'][0]['meter_serial_number'] == 'Meter 1'
    assert data['daily']['data']['result']['records'][0]['meters'][0]['meter_serial_number'] == 'Meter 2'
    assert data['monthly']['data']['result']['records'][0]['meters'][0]['read_at'] == '2024-09-01'
    assert 'PRIVATE' not in await response.text()

@pytest.mark.asyncio
async def test_failed_resolution_does_not_discard_others_or_leak_errors(client, monkeypatch):
    calls = []
    async def send(api, endpoint, body, account, **kwargs):
        calls.append(kwargs['GRANULARITY'])
        if kwargs['GRANULARITY'] == '20':
            raise aiohttp.ClientConnectionError('PRIVATE token and account')
        return {'records': []}
    monkeypatch.setattr(server.API, 'send_request', send)
    await login(client)
    response = await client.post('/api/readings', headers=HEADERS, json={})
    data = (await response.json())['datasets']
    assert calls == ['10', '20', '40']
    assert data['hourly']['status'] == data['monthly']['status'] == 'ok'
    assert data['daily']['status'] == 'error'
    assert 'PRIVATE' not in await response.text()
