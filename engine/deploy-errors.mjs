// Error messages can contain tokens, request headers, or complete credential-bearing URLs.
// Inspect them only for classification; never return or log their contents.
function endpointHost(base) {
  try {
    const endpoint = new URL(base);
    if (['http:', 'https:'].includes(endpoint.protocol) && endpoint.host) return endpoint.host;
  } catch {}
  return '分发服务';
}

export function describeDeployNetworkError(error, base, stage = 'metadata') {
  const host = endpointHost(base);
  const code = error?.cause?.code || error?.code || '';
  const causeMessage = typeof error?.cause?.message === 'string' ? error.cause.message : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  const clues = `${causeMessage}\n${message}`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `解析不出地址「${host}」—— 检查地址拼写和 DNS 设置`;
  }
  if (code === 'ECONNREFUSED') {
    return `连不上 ${host}：对方拒绝了连接（服务没跑或端口不对）`;
  }
  if (code === 'ECONNRESET') {
    return `连接被 ${host} 中断 —— 可能是网络不稳，请稍后重试`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `连不上 ${host}（网络不通）—— 检查地址、端口和网络路由`;
  }
  if (/bad port|invalid port/i.test(clues) || code === 'ERR_SOCKET_BAD_PORT') {
    return `地址里的端口不对（${host}）—— 检查端口是否为 1~65535，以及是否被客户端限制`;
  }
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/i.test(code) || /certificate|self.signed/i.test(clues)) {
    return `HTTPS 证书校验没过（${host}）—— 检查域名、系统时间和证书配置，或联系服务提供者`;
  }
  if (error?.name === 'TimeoutError' ||
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return stage === 'download'
      ? `下载超时（${host}）—— 网络慢或服务响应过久，请稍后重试`
      : `连服务器超时（${host}）—— 检查网络、防火墙和对方端口是否对外放行`;
  }
  return stage === 'download'
    ? `下载中断（${host}）—— 请检查分发服务地址和网络后重试`
    : `连不上分发服务（${host}）—— 请检查分发服务地址和网络后重试`;
}
