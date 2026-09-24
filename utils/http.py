"""Bounded public HTTP fetches; DNS is checked by the connection resolver."""
import ipaddress
import json
import socket
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urljoin, urlsplit
import aiohttp
from ..services.models import MediaError

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def domain_matches(host: str, domains) -> bool:
    return any(host == domain or host.endswith('.' + domain) for domain in domains)


def public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address.split('%')[0])
    return ip.is_global and not (ip.version == 6 and ip.ipv4_mapped and not ip.ipv4_mapped.is_global)


def validate_url(url: str, domains=None) -> str:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower().rstrip('.')
        if (parsed.scheme not in {'http', 'https'} or not host or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 80, 443)
                or '\\' in url or any(ord(c) < 32 for c in url)):
            raise ValueError
        if domains is not None and not domain_matches(host, domains):
            raise ValueError
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if host == 'localhost' or host.endswith(('.localhost', '.local')):
                raise ValueError
        else:
            if not public_ip(host):
                raise ValueError
    except ValueError:
        raise MediaError('链接地址不受支持或指向非公网地址。') from None
    return host


class PublicResolver(aiohttp.abc.AbstractResolver):
    def __init__(self):
        self.delegate = aiohttp.resolver.ThreadedResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        rows = await self.delegate.resolve(host, port, family)
        if not rows or any(not public_ip(row['host']) for row in rows):
            raise OSError('Non-public DNS result rejected')
        return rows

    async def close(self):
        await self.delegate.close()


class PublicHTTP:
    def __init__(self, timeout: int = 20):
        self.timeout = timeout
        self.session = None

    async def __aenter__(self):
        self.resolver = PublicResolver()
        connector = aiohttp.TCPConnector(resolver=self.resolver, limit=4, use_dns_cache=False)
        self.session = aiohttp.ClientSession(
            connector=connector, cookie_jar=aiohttp.DummyCookieJar(), trust_env=False,
            timeout=aiohttp.ClientTimeout(total=self.timeout, connect=min(10, self.timeout)),
            headers={'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9'},
        )
        return self

    async def __aexit__(self, *args):
        await self.session.close()
        await self.resolver.close()

    @asynccontextmanager
    async def open(self, url, *, domains=None, cookie='', cookie_domains=(), referer='', timeout=None,
                   user_agent='', origin='', accept=''):
        for _ in range(6):
            host = validate_url(url, domains)
            headers = {}
            if cookie and domain_matches(host, cookie_domains):
                headers['Cookie'] = cookie
            if referer:
                headers['Referer'] = referer
            if user_agent:
                headers['User-Agent'] = user_agent
            if origin:
                headers['Origin'] = origin
            if accept:
                headers['Accept'] = accept
            async with self.session.get(url, headers=headers, allow_redirects=False,
                                        timeout=aiohttp.ClientTimeout(total=timeout or self.timeout)) as response:
                if response.status in (301, 302, 303, 307, 308):
                    location = response.headers.get('Location')
                    if not location:
                        raise MediaError('短链接跳转缺少目标地址。')
                    url = urljoin(url, location)
                    continue
                if response.status >= 400:
                    raise MediaError(f'平台请求失败（HTTP {response.status}），可能需要有效 Cookie 或稍后重试。')
                yield response
                return
        raise MediaError('短链接跳转次数过多。')

    async def douyin_guest_cookie(self) -> str:
        """Obtain the normal anonymous visitor cookie, without a login account."""
        url = 'https://ttwid.bytedance.com/ttwid/union/register/'
        validate_url(url, ('bytedance.com',))
        payload = {'aid': 1768, 'union': True, 'needFid': False, 'region': 'cn',
                   'cbUrlProtocol': 'https', 'service': 'www.ixigua.com',
                   'migrate_info': {'ticket': '', 'source': 'node'}}
        async with self.session.post(url, json=payload, allow_redirects=False,
                                     timeout=aiohttp.ClientTimeout(total=10)) as response:
            if response.status != 200 or 'ttwid' not in response.cookies:
                return ''
            return 'ttwid=' + response.cookies['ttwid'].value

    async def text(self, url, **kwargs):
        async with self.open(url, **kwargs) as response:
            parts = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                parts.extend(chunk)
                if len(parts) > 8 * 1024 * 1024:
                    raise MediaError('平台页面过大，已停止解析。')
            return str(response.url), parts.decode('utf-8', errors='replace')

    async def json(self, url, **kwargs):
        _, body = await self.text(url, **kwargs)
        try:
            return json.loads(body)
        except ValueError:
            raise MediaError('平台未返回有效数据，可能触发验证或登录要求。') from None

    async def download(self, url: str, target: Path, maximum: int, *, referer='') -> int:
        try:
            async with self.open(url, referer=referer, timeout=90) as response:
                size = int(response.headers.get('Content-Length', '0'))
                if size > maximum:
                    raise MediaError('媒体大小超过配置上限，已跳过下载。')
                total = 0
                with target.open('wb') as stream:
                    async for chunk in response.content.iter_chunked(65536):
                        total += len(chunk)
                        if total > maximum:
                            raise MediaError('媒体大小超过配置上限，已停止下载。')
                        stream.write(chunk)
                if not total:
                    raise MediaError('平台返回了空媒体文件。')
                return total
        except BaseException:
            target.unlink(missing_ok=True)
            raise
