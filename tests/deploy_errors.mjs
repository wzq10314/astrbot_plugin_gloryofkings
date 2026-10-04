// Exercise the actual adapted network functions; every fetch is a synthetic response.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

assert.ok(process.argv[2], 'Pass the prepared runtime plugins/GloryOfKings-Plugin directory');
const {fetchPackageMeta, downloadPackage} = await import(pathToFileURL(path.join(process.argv[2], 'utils/deploy.js')));
const secrets = ['USERNAME_SECRET', 'PASSWORD_SECRET', 'PATH_SECRET', 'QUERY_SECRET',
  'FRAGMENT_SECRET', 'TOKEN_SECRET', 'MESSAGE_SECRET', 'CODE_SECRET', 'NAME_SECRET'];
const url = 'https://USERNAME_SECRET:PASSWORD_SECRET@distribution.example:8443/PATH_SECRET?key=QUERY_SECRET#FRAGMENT_SECRET';
const options = {name: 'watch', url, token: 'TOKEN_SECRET'};
const logs = [];
options.logger = {warn: (...args) => logs.push(args)};
const originalFetch = globalThis.fetch;
let checks = 0;
function assertSafe(result) {
  assert.equal(result.ok, false);
  for (const secret of secrets) assert.ok(!JSON.stringify(result).includes(secret), 'Response leaked a secret');
  assert.deepEqual(logs, [], 'Network failures must not log original errors or URLs');
  assert.doesNotMatch(result.message, /http:\/\/|关闭.*证书|跳过.*证书/);
}
const makeError = (code, causeMessage = '', name = 'TypeError') => ({
  name, message: `MESSAGE_SECRET ${url} Authorization: Bearer TOKEN_SECRET`,
  cause: {code, message: `${causeMessage} MESSAGE_SECRET ${url}`}
});

try {
  const failures = [
    ['DNS lookup', makeError('ENOTFOUND'), /解析不出地址/],
    ['temporary DNS', makeError('EAI_AGAIN'), /解析不出地址/],
    ['connection refused', makeError('ECONNREFUSED'), /拒绝了连接/],
    ['connection reset', makeError('ECONNRESET'), /连接被.*中断/],
    ['host unreachable', makeError('EHOSTUNREACH'), /网络不通/],
    ['network unreachable', makeError('ENETUNREACH'), /网络不通/],
    ['bad port', makeError('', 'bad port'), /端口不对/],
    ['invalid port', makeError('', 'invalid port'), /端口不对/],
    ['socket port', makeError('ERR_SOCKET_BAD_PORT'), /端口不对/],
    ['certificate code', makeError('CERT_HAS_EXPIRED'), /HTTPS 证书校验没过.*系统时间.*服务提供者/],
    ['TLS code', makeError('ERR_TLS_CERT_ALTNAME_INVALID'), /HTTPS 证书校验没过.*域名/],
    ['SSL code', makeError('ERR_SSL_WRONG_VERSION_NUMBER'), /HTTPS 证书校验没过/],
    ['certificate cause', makeError('', 'certificate verify failed'), /HTTPS 证书校验没过/],
    ['self signed', makeError('', 'self signed certificate'), /HTTPS 证书校验没过/],
    ['timeout name', makeError('', '', 'TimeoutError'), /超时/],
    ['socket timeout', makeError('ETIMEDOUT'), /超时/],
    ['connect timeout', makeError('UND_ERR_CONNECT_TIMEOUT'), /超时/],
    ['headers timeout', makeError('UND_ERR_HEADERS_TIMEOUT'), /超时/],
    ['body timeout', makeError('UND_ERR_BODY_TIMEOUT'), /超时/],
    ['arbitrary code and name', makeError('CODE_SECRET', '', 'NAME_SECRET'), /检查分发服务地址和网络/],
    ['missing error', null, /检查分发服务地址和网络/],
    ['node-fetch code', {code: 'ECONNREFUSED', message: 'MESSAGE_SECRET'}, /拒绝了连接/],
  ];
  for (const [label, error, expected] of failures) {
    globalThis.fetch = async () => {throw error};
    for (const request of [fetchPackageMeta, downloadPackage]) {
      const result = await request(options);
      assertSafe(result);
      assert.match(result.message, expected, label);
      assert.match(result.message, /distribution\.example:8443/, label);
      if (/timeout/.test(label)) assert.match(result.message, request === downloadPackage ? /下载超时/ : /连服务器超时/);
      checks++;
    }
  }
  // Invalid URLs must never fall back to echoing the input string or its userinfo.
  for (const invalidUrl of ['https://USERNAME_SECRET:PASSWORD_SECRET@broken.invalid:99999/PATH_SECRET',
    'https://USERNAME_SECRET:PASSWORD_SECRET@/PATH_SECRET?QUERY_SECRET']) {
    globalThis.fetch = async () => {throw makeError('', 'invalid port')};
    for (const request of [fetchPackageMeta, downloadPackage]) {
      const result = await request({...options, url: invalidUrl});
      assertSafe(result);
      assert.match(result.message, /端口不对（分发服务）/);
      checks++;
    }
  }
  for (const [status, expected] of [[401, /令牌无效/], [403, /令牌已被吊销/],
    [404, /没有「watch」这个包/], [429, /请求太频繁/], [503, /503/]]) {
    globalThis.fetch = async () => ({status, ok: false,
      async text() {throw Error('Response body must not be exposed')},
      async json() {throw Error('Response body must not be exposed')}});
    for (const request of [fetchPackageMeta, downloadPackage]) {
      const result = await request(options);
      assertSafe(result);
      assert.match(result.message, expected);
      checks++;
    }
  }
  globalThis.fetch = async () => ({status: 200, ok: true, async json() {throw Error('MESSAGE_SECRET')}});
  const malformed = await fetchPackageMeta(options);
  assertSafe(malformed);
  assert.match(malformed.message, /内容看不懂/);
  checks++;
  globalThis.fetch = async () => ({status: 200, ok: true, async arrayBuffer() {throw makeError('ECONNRESET')}});
  const interrupted = await downloadPackage(options);
  assertSafe(interrupted);
  assert.match(interrupted.message, /连接被.*中断/);
  checks++;
  globalThis.fetch = async (target, init) => {
    assert.equal(init.headers.Authorization, 'Bearer TOKEN_SECRET');
    assert.match(target, /\/api\/v1\/packages\/watch\//);
    return {status: 200, ok: true, async json() {return {sha: 'fixture-sha', size: 7, sha256: 'fixture-digest'}},
      async arrayBuffer() {return new TextEncoder().encode('fixture').buffer}, headers: new Headers({'x-gok-sha': 'fixture-sha'})};
  };
  assert.deepEqual(await fetchPackageMeta(options), {ok: true, sha: 'fixture-sha', size: 7, sha256: 'fixture-digest'});
  const downloaded = await downloadPackage(options);
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.buffer.toString(), 'fixture');
  assert.equal(downloaded.sha, 'fixture-sha');
  checks += 2;
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`Deployment network diagnostics: ${checks} checks passed`);
