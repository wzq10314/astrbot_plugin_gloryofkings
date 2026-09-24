/**
 * 调 pm2 的统一入口（跨平台）。
 *
 * 直接 `execSync('pm2 restart x')` 在 Windows 上很容易失败，原因不是没装：
 * Yunzai 进程的 PATH 停在它启动那一刻，`npm i -g pm2` 之后写进注册表的新 PATH
 * 只对新进程生效，已经跑着的 Yunzai 和它 spawn 出来的子进程都看不见 ——
 * 表现就是「明明装了 pm2」却报 command not found，还容易被误判成进程名填错。
 * 所以先按 PATH 找，找不到就去 npm 全局目录按文件名捞。
 *
 * 另外走 spawnSync + 参数数组而不是拼字符串：路径带空格也不用自己加引号。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/** 解析一次就够，pm2 装在哪不会在运行期变 */
let cached
let cachedResolved = false

/**
 * Windows 上除了 .exe 一律得经 shell：
 * - `.cmd`/`.bat` 从 Node 18.20 起不能直接 spawn（会被拒）
 * - **裸名字 `pm2` 也不行** —— CreateProcess 只认 .exe，不查 PATHEXT，
 *   而 npm 全局包在 Windows 上是 `pm2.cmd`，于是 PATH 里明明有也报 ENOENT。
 *   交给 cmd.exe 它才会按 PATHEXT 补后缀找到 .cmd。
 *   顺带避开了 npm 那个 `pm2.ps1` 包装（.ps1 不在 PATHEXT 里，cmd 不会命中它，
 *   而它用 $args 转发会吃掉参数终止符 `--`）。
 */
function needsShell (bin) {
  return IS_WIN && !/\.exe$/i.test(bin)
}

function quote (s) {
  return /[\s&|()<>^"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** 拿 `-v` 试一下这个名字/路径能不能直接跑起来 */
function probe (bin) {
  try {
    const r = needsShell(bin)
      ? spawnSync(`${quote(bin)} -v`, { shell: true, stdio: 'ignore', timeout: 20000, windowsHide: true })
      : spawnSync(bin, ['-v'], { stdio: 'ignore', timeout: 20000, windowsHide: true })
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

/** pm2 可能装在哪 —— 按 PATH 之外的常见位置排 */
function candidates () {
  const nodeDir = path.dirname(process.execPath)
  if (IS_WIN) {
    return [
      // npm i -g 的默认落点，也是 Windows 上最常见的一个
      path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd'),
      path.join(nodeDir, 'pm2.cmd'),
      path.join(process.env.ProgramFiles || '', 'nodejs', 'pm2.cmd'),
      path.join(process.env.ALLUSERSPROFILE || '', 'npm', 'pm2.cmd')
    ]
  }
  return [
    // nvm 装的 node，全局包和 node 同一个 bin 目录，而这个目录常常不在 PATH 上
    path.join(nodeDir, 'pm2'),
    '/usr/local/bin/pm2',
    '/usr/bin/pm2',
    path.join(process.env.HOME || '', '.local/bin/pm2')
  ]
}

/**
 * 找到能用的 pm2，找不到返回 null。
 * @returns {string|null}
 */
export function pm2Bin () {
  if (cachedResolved) return cached
  cachedResolved = true
  cached = null

  if (probe('pm2')) {
    cached = 'pm2'
    return cached
  }
  for (const p of candidates()) {
    if (p && fs.existsSync(p) && probe(p)) {
      cached = p
      return cached
    }
  }
  return cached
}

/** 下次调用重新探测（装完 pm2 不用重启 Yunzai 就能被认到） */
export function resetPm2Cache () {
  cachedResolved = false
  cached = null
}

/**
 * 跑一条 pm2 命令。
 * @param {string[]} args 参数数组，如 ['restart', 'gok-share']
 * @param {{timeout?: number}} opts
 * @returns {{ok: boolean, out: string, err: string, missing: boolean}}
 */
export function pm2 (args = [], { timeout = 120000 } = {}) {
  const bin = pm2Bin()
  if (!bin) {
    return {
      ok: false,
      out: '',
      missing: true,
      err: IS_WIN
        ? '找不到 pm2。装过的话多半是 Yunzai 还拿着旧的 PATH，重启 Yunzai 即可；没装就先 npm i -g pm2'
        : '找不到 pm2，先装一个：npm i -g pm2'
    }
  }

  const r = needsShell(bin)
    ? spawnSync([bin, ...args].map(quote).join(' '),
      { shell: true, encoding: 'utf-8', timeout, windowsHide: true })
    : spawnSync(bin, args, { encoding: 'utf-8', timeout, windowsHide: true })

  return {
    ok: !r.error && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error ? r.error.message : ''),
    missing: false
  }
}

/**
 * `pm2 jlist` 里指定名字的进程，没有则 null。
 * jlist 是纯 JSON，比 `pm2 list` 的表格好解析。
 */
export function pm2Proc (name) {
  const r = pm2(['jlist'], { timeout: 30000 })
  if (!r.ok || !r.out) return null

  try {
    // 某些 pm2 版本会在 JSON 前面吐一行提示，从第一个 [ 开始截
    const i = r.out.indexOf('[')
    return JSON.parse(i > 0 ? r.out.slice(i) : r.out).find(p => p.name === name) || null
  } catch {
    return null
  }
}

/**
 * 判断某个 pm2 进程是不是**我们自己起的那个**。
 *
 * 光比名字不够：别人完全可能也有个叫同名进程的东西，而卸载动作会把它停掉、删掉。
 * 所以要看它跑的是不是我们 server 目录下的入口，cwd 和脚本路径任一命中才算。
 * （这个教训是从 meme 插件的卸载逻辑里带过来的。）
 *
 * @param {object|null} proc pm2Proc 的返回值
 * @param {string} serverDir 服务端目录绝对路径
 */
export function isOurProcess (proc, serverDir) {
  if (!proc) return false

  const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase()
  const want = norm(serverDir)

  const cwd = norm(proc.pm2_env?.pm_cwd || proc.pm2_env?.cwd)
  const script = norm(proc.pm2_env?.pm_exec_path)

  return cwd.startsWith(want) || script.startsWith(want)
}
