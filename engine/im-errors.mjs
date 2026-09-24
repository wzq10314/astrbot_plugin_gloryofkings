// Never echo raw server errors: they can include credentials or message bodies.
export function imSendFailure(result) {
  const candidates=[result?.code,result?.retCode,result?.returnCode,
    result?.raw?.retCode,result?.raw?.returnCode,result?.raw?.code];
  const code=candidates.find(value=>(typeof value==='number'&&Number.isSafeInteger(value))||
    (typeof value==='string'&&/^-?\d{1,12}$/.test(value)));
  let reason='营地接口未确认发送成功';
  if(result?.code==='no-account')reason='发送账号未登录或登录凭据不完整';
  else {
    const error=String(result?.error||'');
    if(/缺 selfUserId \/ toUserId \/ message/.test(error))reason='发送账号、收件人或正文参数缺失';
    else if(/fetch failed|ECONN|ETIMEDOUT|timeout|aborted/i.test(error))reason='服务端请求营地接口时发生网络异常或超时';
  }
  return '未确认发送成功：'+reason+(code!==undefined?`（错误码：${code}）`:'（未返回可展示错误码）')+
    '。请先确认对方是否收到，避免重复发送；排查时提供本条提示即可，不要发送登录凭据。';
}
