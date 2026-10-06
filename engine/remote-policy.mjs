// Only explicitly approved endpoints may receive global camp login credentials.
export const REMOTE_NOTICE = '请先在 AstrBot 后台「允许接收营地登录凭据的远端地址」填写此服务的完整地址。该操作会把全局营地账号登录凭据发送给对方，仅填写你控制或信任的服务。';
export function approvedRemote(base, allowed) {
  const normalize = value => {
    try {
      const url = new URL(String(value));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      return url.href.replace(/\/+$/, '');
    } catch { return null; }
  };
  const target = normalize(base);
  return Boolean(target && Array.isArray(allowed) && allowed.some(value => normalize(value) === target));
}
