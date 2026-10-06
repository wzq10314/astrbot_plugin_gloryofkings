// Read-only query credentials from an explicitly selected local account pool.
// This module never imports accounts into the destination's ownership/IM stores.
import fs from 'node:fs';
import path from 'node:path';

export const SHARED_QUERY_SOURCE = 'adapter-shared-global';
export const MAX_SHARED_POOL_BYTES = 2 * 1024 * 1024;

const QUERY_FIELDS = [
  'token', 'userKey', 'encodeRes', 'openId', 'gameOpenId', 'gameRoleId',
  'gameServerId', 'gameAreaId', 'gameUserSex', 'kohDimGender', 'xLogUid',
  'traceparent', 'serverTimeOffsetMs', 'userAgent', 'xClientProto',
  'contentEncrypt', 'acceptEncrypt', 'noEncrypt', 'isTrpcRequest',
  'cChannelId', 'cClientVersionCode', 'cClientVersionName', 'cCurrentGameId',
  'cGameId', 'cGzip', 'cIsArm64', 'cSupportArm64', 'cSystem',
  'cSystemVersionCode', 'cSystemVersionName', 'cpuHardware', 'tinkerId', 'publicKey',
];

function identifier(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value);
  return /^\d{1,32}$/.test(id) ? id : '';
}

function presentString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readPool(sourcePool) {
  if (typeof sourcePool !== 'string' || !path.isAbsolute(sourcePool)) return null;
  const file = path.resolve(sourcePool);
  // Reject leaf symlinks and ancestor directory links/junctions as well.
  let cursor = file;
  for (;;) {
    if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size <= 0 || before.size > MAX_SHARED_POOL_BYTES) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) return null;
    // Bound the read even if another process grows the file after the stat.
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (length !== opened.size || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs) return null;
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The caller must validate sourcePool against its configured source namespace.
 * An empty allowlist grants nothing. Every call reads a fresh, bounded snapshot.
 * Shared candidates must bypass the destination authStore's status writebacks.
 */
export function readSharedQueryCandidates(sourcePool, allowedUserIds) {
  try {
    if (!Array.isArray(allowedUserIds) || !allowedUserIds.length) return [];
    const allowed = new Set(allowedUserIds.map(identifier).filter(Boolean));
    if (!allowed.size) return [];
    const pool = readPool(sourcePool);
    if (!pool || typeof pool !== 'object' || Array.isArray(pool) ||
        !pool.accounts || typeof pool.accounts !== 'object' || Array.isArray(pool.accounts)) return [];
    const candidates = [];
    for (const [key, account] of Object.entries(pool.accounts)) {
      if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
      const userId = identifier(account.userId);
      if (!userId || userId !== key || !allowed.has(userId) ||
          account.isGlobalDefault !== true || account.authInvalid ||
          !presentString(account.token) ||
          !(presentString(account.userKey) || presentString(account.encodeRes))) continue;
      const auth = {userId, enabled: true, isGlobalDefault: true, authInvalid: false};
      for (const field of QUERY_FIELDS) {
        const value = account[field];
        if (typeof value === 'string' || typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))) auth[field] = value;
      }
      auth.priority = Number.isFinite(Number(account.priority)) ? Number(account.priority) : 100;
      candidates.push({auth, source: SHARED_QUERY_SOURCE, label: '共享查询账号'});
    }
    return candidates.sort((left, right) =>
      left.auth.priority - right.auth.priority || left.auth.userId.localeCompare(right.auth.userId));
  } catch {
    // Paths, JSON fragments and filesystem error messages may contain credentials.
    return [];
  }
}
