"""Bounded async subprocess execution; no command interpreter."""
import asyncio
import os
import signal
from dataclasses import dataclass


@dataclass
class ProcessResult:
    code: int
    output: str
    timed_out: bool = False
    truncated: bool = False


async def run_process(argv: list[str], timeout: float, limit: int, *, cwd=None, env=None) -> ProcessResult:
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=(os.name == "posix"), cwd=cwd, env=env,
    )
    captured = bytearray()
    truncated = False

    async def drain():
        nonlocal truncated
        while chunk := await proc.stdout.read(4096):
            remaining = max(0, limit * 4 - len(captured))
            captured.extend(chunk[:remaining])
            truncated |= len(chunk) > remaining
        await proc.wait()

    async def kill():
        try:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            elif proc.returncode is None:
                # A cancelled browser task must not leave Chromium children running.
                try:
                    killer = await asyncio.create_subprocess_exec(
                        'taskkill', '/PID', str(proc.pid), '/T', '/F',
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                    try: await asyncio.wait_for(killer.wait(), 5)
                    except TimeoutError:
                        killer.kill()
                        await killer.wait()
                except OSError:
                    pass
                if proc.returncode is None: proc.kill()
        except ProcessLookupError:
            pass

    task = asyncio.create_task(drain())
    timed_out = False
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout)
    except TimeoutError:
        timed_out = True
    finally:
        # Also clean up descendants when the parent exits or the handler is cancelled.
        await kill()
        try:
            await asyncio.wait_for(task, 2)
        except TimeoutError:
            task.cancel()
        await proc.wait()
    text = captured.decode("utf-8", errors="replace")
    return ProcessResult(proc.returncode, text[:limit], timed_out, truncated or len(text) > limit)
