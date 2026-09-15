"""Small, single-process, memory-only Anglian Water export service."""
import asyncio
import contextlib
import logging
import os
import math
import re
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
from pyanglianwater.api import API
from pyanglianwater.auth import MSOB2CAuth
from pyanglianwater import exceptions as aw_errors

# Upstream logs can include credentials, tokens, account IDs and response bodies.
# Suppress the entire namespace, including future child loggers.
logging.getLogger('pyanglianwater').handlers = [logging.NullHandler()]
logging.getLogger('pyanglianwater').propagate = False
logging.getLogger('pyanglianwater').setLevel(logging.CRITICAL + 1)

COOKIE = 'water_ledger_session'
TTL = 1800
STATIC = Path(__file__).parent / 'static'
STORE = web.AppKey('sessions', dict)
ORIGIN = web.AppKey('origin', str)
SECURE = web.AppKey('secure', bool)
FACTORY = web.AppKey('auth_factory', object)
ATTEMPTS = web.AppKey('attempts', deque)

class PrivateAuth(MSOB2CAuth):
    """Discard identity claims and login artifacts after authentication/refresh."""
    def minimize(self):
        if self.auth_data:
            self.auth_data = {k: v for k, v in self.auth_data.items() if k in {
                'access_token', 'refresh_token', 'extension_business_partner_number'}}
        self.username = self._password = ''
        for key in ('_pkce_verifier', '_pkce_challenge', '_state', '_csrf_token',
                    '_trans_id', '_mfa_readonly_email'):
            setattr(self, key, None)
        self._cookie_cache.clear()
        self._auth_session.cookie_jar.clear()

    async def send_login_request(self):
        await super().send_login_request()
        if self.access_token:
            self.minimize()

    async def send_mfa_request(self, code):
        await super().send_mfa_request(code)
        if self.access_token:
            self.minimize()

    async def send_refresh_request(self):
        await super().send_refresh_request()
        self.minimize()

def usage_only(data):
    """Allowlist usage scalars; never forward metadata or real meter identifiers."""
    body = data.get('result', data) if isinstance(data, dict) else data
    records = body.get('records', body) if isinstance(body, dict) else body
    if not isinstance(records, list):
        raise ValueError('Invalid usage schema')
    labels, output = {}, []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('meters'), list):
            raise ValueError('Invalid usage schema')
        meters = []
        for meter in record['meters']:
            if not isinstance(meter, dict):
                raise ValueError('Invalid usage schema')
            serial = meter.get('meter_serial_number')
            if type(serial) not in (str, int) or not str(serial).strip():
                raise ValueError('Invalid meter')
            label = labels.setdefault(str(serial), f'Meter {len(labels) + 1}')
            timestamp = meter.get('read_at')
            if not isinstance(timestamp, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?', timestamp):
                raise ValueError('Invalid timestamp')
            clean = {'meter_serial_number': label, 'read_at': timestamp}
            for key in ('consumption', 'read'):
                value = meter.get(key)
                if type(value) not in (str, int, float):
                    raise ValueError('Invalid usage number')
                clean[key] = float(value)
                if not math.isfinite(clean[key]):
                    raise ValueError('Invalid usage number')
            meters.append(clean)
        output.append({'meters': meters})
    return {'result': {'records': output}}

@dataclass(repr=False)
class Session:
    http: aiohttp.ClientSession
    auth: object
    account: str
    expires: float = field(default_factory=lambda: time.monotonic() + TTL)
    state: str = 'mfa'
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_load: float = 0
    mfa_attempts: int = 0

    async def close(self):
        self.auth.__dict__.clear()
        self.auth._password = ''
        self.auth.auth_data = None
        self.auth._refresh_token = None
        self.account = ''
        self.http.cookie_jar.clear()
        await self.http.close()

def problem(text, status=400):
    return web.json_response({'ok': False, 'error': text}, status=status)

def error_response(exc):
    if isinstance(exc, aw_errors.ConsentRequiredError):
        return problem('Open Anglian Water MyAccount and review its consent or terms prompt, then sign in here again.', 403)
    if isinstance(exc, (aw_errors.InvalidGrantError, aw_errors.ExpiredAccessTokenError)):
        return problem('Your login has expired or was rejected. Sign in again.', 401)
    if isinstance(exc, aw_errors.SelfAssertedError):
        return problem('Anglian Water could not sign you in. Check your email and password.', 401)
    if isinstance(exc, aw_errors.InvalidAccountIdError):
        return problem('That account number is not available to this login. Check the number on your bill.', 403)
    # Use an application dependency failure rather than a gateway status: some
    # reverse proxies replace 502 bodies, hiding our safe JSON error message.
    if isinstance(exc, aiohttp.ContentTypeError):
        return problem('Anglian Water returned an unexpected sign-in page. Please try again later.', 424)
    if isinstance(exc, (aiohttp.ClientError, TimeoutError)):
        return problem('Could not reach Anglian Water. Please try again later.', 424)
    if isinstance(exc, aw_errors.UnknownEndpointError):
        if exc.status == 429:
            return problem('Anglian Water is limiting requests. Wait a few minutes before retrying.', 429)
        return problem('Anglian Water could not supply hourly data. Check your smart-meter account and try again later.', 424)
    # Never return upstream exception strings; they can contain private data.
    return problem('Anglian Water returned an unexpected response. Try signing in again. No CSV was created.', 424)

@web.middleware
async def security(request, handler):
    if request.method not in {'GET', 'HEAD'}:
        if request.headers.get('Origin') != request.app[ORIGIN] or request.headers.get('X-Water-Ledger') != '1':
            response = problem('This request must come from the app itself.', 403)
        elif request.content_type != 'application/json':
            response = problem('Expected JSON.', 415)
        else:
            response = await safe_handle(request, handler)
    else:
        response = await safe_handle(request, handler)
    response.headers.update({
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    })
    return response

async def safe_handle(request, handler):
    try:
        return await handler(request)
    except web.HTTPException as exc:
        return problem('Request rejected.', exc.status)
    except Exception as exc:
        return error_response(exc)

async def body(request):
    try:
        result = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest()
    if not isinstance(result, dict):
        raise web.HTTPBadRequest()
    return result

async def drop(request):
    sid = request.cookies.get(COOKIE)
    item = request.app[STORE].pop(sid, None)
    if item:
        async with item.lock:
            await item.close()

async def get_session(request):
    sid = request.cookies.get(COOKIE)
    item = request.app[STORE].get(sid)
    if item and item.expires <= time.monotonic():
        await drop(request)
        return None
    return item

def with_cookie(response, request, sid):
    response.set_cookie(COOKIE, sid, httponly=True, secure=request.app[SECURE], samesite='Strict', path='/')
    return response

async def login(request):
    values = await body(request)
    username, password, account = (values.get(k) for k in ('username', 'password', 'account'))
    if not all(isinstance(v, str) for v in (username, password, account)):
        return problem('Enter your email, password and account number.')
    username, account = username.strip(), account.strip()
    if not username or len(username) > 254 or not password or len(password) > 1024 or not account.isascii() or not account.isdigit() or not 5 <= len(account) <= 20:
        return problem('Check your email, password and the numeric account number on your bill.')
    attempts = request.app[ATTEMPTS]
    now = time.monotonic()
    while attempts and attempts[0] < now - 600:
        attempts.popleft()
    if len(attempts) >= 30:
        return problem('Too many sign-in attempts. Please wait ten minutes.', 429)
    attempts.append(now)
    await drop(request)
    if len(request.app[STORE]) >= 100:
        return problem('The app has reached its session limit. Please try again later.', 503)
    # Azure B2C rejects aiohttp's quoted cookie representation. Keep provider
    # cookie values unchanged; this does not disable TLS or cookie scoping.
    http = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(quote_cookie=False),
                                 timeout=aiohttp.ClientTimeout(total=45))
    auth = request.app[FACTORY](username, password, session=http)
    item = Session(http, auth, account)
    sid = secrets.token_urlsafe(32)
    try:
        async with asyncio.timeout(90):
            await auth.send_login_request()
        if not auth.access_token:
            await item.close()
            return problem('Anglian Water did not complete sign-in. Check your details or sign in on MyAccount first.', 401)
        item.state = 'connected'
    except aw_errors.MFARequiredError:
        item.state = 'mfa'
    except Exception as exc:
        await item.close()
        return error_response(exc)
    except BaseException:
        await item.close()
        raise
    finally:
        auth._password = ''
        auth.username = ''
        values.clear()
        password = ''
    request.app[STORE][sid] = item
    return with_cookie(web.json_response({'ok': True, 'status': item.state}), request, sid)

async def mfa(request):
    item = await get_session(request)
    if not item or item.state != 'mfa':
        return problem('The verification session expired. Sign in again.', 401)
    values = await body(request)
    code = values.get('code')
    if not isinstance(code, str) or not code.isascii() or not code.isdigit() or not 4 <= len(code) <= 10:
        return problem('Enter the verification code from Anglian Water.')
    async with item.lock:
        if item.mfa_attempts >= 5:
            return problem('Too many verification attempts. Sign out and start again.', 429)
        item.mfa_attempts += 1
        try:
            async with asyncio.timeout(90):
                await item.auth.send_mfa_request(code)
            if not item.auth.access_token:
                return problem('Verification did not complete. Sign in again.', 401)
            item.state = 'connected'
            item.expires = time.monotonic() + TTL
        except aw_errors.MFARequiredError:
            return problem('That code was not accepted. Check the latest email and try again.', 401)
        except Exception as exc:
            return error_response(exc)
        finally:
            values.clear()
    return with_cookie(web.json_response({'ok': True, 'status': 'connected'}), request, request.cookies[COOKIE])

async def state(request):
    item = await get_session(request)
    return web.json_response({'ok': True, 'status': item.state if item else 'disconnected'})

async def logout(request):
    await drop(request)
    response = web.json_response({'ok': True, 'status': 'disconnected'})
    response.del_cookie(COOKIE, path='/')
    return response

async def readings(request):
    item = await get_session(request)
    if not item or item.state != 'connected':
        return problem('Sign in before loading readings.', 401)
    async with item.lock:
        if item.last_load > time.monotonic() - 10:
            return problem('Please wait ten seconds between refreshes.', 429)
        item.last_load = time.monotonic()
        try:
            async with asyncio.timeout(60):
                data = await API(item.auth).send_request('get_usage_details', None, item.account, GRANULARITY='10')
        except Exception as exc:
            return error_response(exc)
        if request.app[STORE].get(request.cookies.get(COOKIE)) is not item:
            return problem('You signed out while the readings were loading.', 401)
        item.expires = time.monotonic() + TTL
    return with_cookie(web.json_response({'ok': True, 'data': usage_only(data)}), request, request.cookies[COOKIE])

async def cleanup(app):
    async def sweep():
        while True:
            await asyncio.sleep(30)
            for sid, item in list(app[STORE].items()):
                if item.expires <= time.monotonic() and not item.lock.locked():
                    app[STORE].pop(sid, None)
                    await item.close()
    task = asyncio.create_task(sweep())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    for item in list(app[STORE].values()):
        await item.close()
    app[STORE].clear()

def create_app(origin=None, secure=None, auth_factory=PrivateAuth):
    app = web.Application(middlewares=[security], client_max_size=16384)
    app[ORIGIN] = (origin or os.getenv('APP_ORIGIN', 'http://localhost:8080')).rstrip('/')
    parsed = urlsplit(app[ORIGIN])
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('APP_ORIGIN must be an exact HTTP(S) origin without a path.')
    app[SECURE] = secure if secure is not None else parsed.scheme == 'https'
    app[STORE], app[ATTEMPTS], app[FACTORY] = {}, deque(), auth_factory
    app.cleanup_ctx.append(cleanup)
    async def health(_):
        return web.json_response({'status': 'ok'})
    app.router.add_get('/health', health)
    app.router.add_get('/api/session', state)
    app.router.add_post('/api/login', login)
    app.router.add_post('/api/mfa', mfa)
    app.router.add_post('/api/logout', logout)
    app.router.add_post('/api/readings', readings)
    async def asset(request):
        name = request.match_info.get('name', 'index.html')
        if name not in {'index.html', 'app.js', 'api.js', 'data.js', 'styles.css', 'icon.svg'}:
            raise web.HTTPNotFound()
        return web.FileResponse(STATIC / name)
    app.router.add_get('/', asset)
    app.router.add_get('/{name}', asset)
    return app

if __name__ == '__main__':
    # Parser errors and third-party diagnostics can also contain request data.
    logging.disable(logging.CRITICAL)
    web.run_app(create_app(), host='0.0.0.0', port=int(os.getenv('PORT', '8080')), access_log=None, print=None)
