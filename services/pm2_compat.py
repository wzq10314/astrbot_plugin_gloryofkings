"""Adapt PM2 only in runtime copies, retaining the byte-exact upstream bundle.

The bridge supplies its installed PM2 entry and its existing isolated PM2_HOME.
Windows keeps upstream lpm2's separate home and explicit legacy migration notice.
Discovery and status must never start a daemon merely to find out whether it exists.
"""


def _once(source: str, before: str, after: str, name: str) -> str:
    if source.count(before) != 1:
        raise ValueError('Upstream PM2 compatibility hook changed: ' + name)
    return source.replace(before, after)


def adapt_pm2(source: str) -> str:
    source = _once(source, """  if (probe('pm2')) {
    cached = 'pm2'
    return cached
  }
  for (const p of candidates()) {
    if (p && fs.existsSync(p) && probe(p)) {
      cached = p
      return cached
    }
  }
  return cached""", """  // AstrBot: resolve the JS entry without invoking the CLI (even -v starts a daemon).
  cached = resolvePm2Js() || null
  return cached""", 'pure discovery')

    source = _once(source, """function resolvePm2Js () {
  return resolvePkgJs('pm2', 'pm2')
}""", """function resolvePm2Js () {
  // Installed with the bridge; runtime copies live outside its node_modules tree.
  const supplied = String(process.env.GOK_PM2_JS || '')
  if (supplied && fs.existsSync(supplied)) return supplied
  return resolvePkgJs('pm2', 'pm2')
}""", 'bridge entry')

    source = _once(source, """    cmd: bin,
    pre: [],
    bin,
    shell: needsShell(bin),""", """    cmd: process.execPath,
    pre: [bin],
    bin,
    shell: false,""", 'direct launcher')

    source = _once(source, """  const r = needsShell(bin)
    ? spawnSync([bin, ...args].map(quote).join(' '), {
      shell: true, encoding: 'utf-8', timeout, windowsHide: true, env: process.env
    })
    : spawnSync(bin, args, { encoding: 'utf-8', timeout, windowsHide: true, env: process.env })""", """  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf-8', timeout, windowsHide: true, env: process.env
  })""", 'legacy launcher')

    source = _once(source, """export function pm2Proc (name) {
  if (launcher()?.kind === 'lpm2' && !hasOwnDaemonHistory()) return null
  return pickProc(pm2(['jlist'], { timeout: 30000 }), name)
}""", """export function pm2Proc (name) {
  const l = launcher()
  if (!l) return null
  const home = l.env?.PM2_HOME || sysPm2Home()
  // A stale dump/pids directory is not proof that a daemon is still running.
  if (!daemonRunning(home)) return null
  return pickProc(pm2(['jlist'], { timeout: 30000 }), name)
}""", 'read-only process status')

    source = _once(source, """function sysPm2HasProcesses () {
  try {
    const pids = path.join(sysPm2Home(), 'pids')
    return fs.existsSync(pids) && fs.readdirSync(pids).length > 0
  } catch {
    return false
  }
}""", """function daemonRunning (home) {
  try {
    const text = String(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8')).trim()
    if (!/^[1-9][0-9]*$/.test(text)) return false
    const pid = Number(text)
    if (!Number.isSafeInteger(pid)) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // An inaccessible process still exists; ESRCH and all other errors mean unknown.
      return error?.code === 'EPERM'
    }
  } catch {
    return false
  }
}

function sysPm2HasProcesses () {
  return daemonRunning(sysPm2Home())
}""", 'read-only legacy status')
    return source
