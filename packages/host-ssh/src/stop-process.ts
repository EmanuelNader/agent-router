import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Start marker of a live process, or undefined when the PID is free or only a zombie awaiting its parent.
 * Linux reads /proc: the start time there counts clock ticks since boot, so a wall-clock correction does not
 * change it, and it needs no `ps` (BusyBox `ps` has no `-p`). Other platforms use `ps`.
 */
async function liveProcessStart(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return undefined;
      throw error;
    }
    // The command name is in parentheses and may itself contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
    const [state, startTicks] = [fields[0], fields[19]];
    if (!state || !startTicks) throw new Error(`Unreadable /proc/${pid}/stat`);
    return state === 'Z' || state === 'X' ? undefined : startTicks;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } }));
  } catch (error) {
    // ps exits 1 with no output when the PID does not exist.
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure.code === 1 && failure.stderr === '') return undefined;
    throw error;
  }
  const [state, ...started] = stdout.trim().split(/\s+/);
  if (!state || started.length === 0 || state.startsWith('Z')) return undefined;
  return started.join(' ');
}

/** Identifies the process to stop later, so a PID that is reused in between is not signalled. */
export async function identifyStoppableProcess(pid: number): Promise<{ pid: number; startedAt: string }> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
    throw new Error('SOURCE_AGENT_PID_INVALID: expected the process ID of the source agent');
  }
  const startedAt = await liveProcessStart(pid);
  if (startedAt === undefined) throw new Error(`SOURCE_AGENT_NOT_RUNNING: no process ${pid}`);
  if (process.platform === 'linux') {
    // /proc also answers for thread IDs; a thread can exit while its process keeps running.
    const tgid = /^Tgid:\s*(\d+)$/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1];
    if (tgid !== String(pid)) {
      throw new Error(`SOURCE_AGENT_PID_INVALID: ${pid} is a thread of process ${tgid ?? 'unknown'}, not a process`);
    }
  }
  return { pid, startedAt };
}

/**
 * Sends SIGTERM to the identified process and waits for it to exit. A process that already exited, including
 * one whose PID now belongs to another process, counts as stopped and is not signalled. It never escalates to
 * SIGKILL: a killed agent may not have flushed its history, so a process that ignores SIGTERM fails the caller.
 */
export async function stopProcess(target: { pid: number; startedAt: string }, timeoutMs = 30_000): Promise<void> {
  const isTargetRunning = async () => (await liveProcessStart(target.pid)) === target.startedAt;
  if (!(await isTargetRunning())) return;
  try {
    process.kill(target.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (await isTargetRunning()) {
    if (Date.now() >= deadline) {
      throw new Error(`SOURCE_AGENT_STILL_RUNNING: process ${target.pid} did not exit within ${timeoutMs} ms of SIGTERM`);
    }
    await delay(100);
  }
}
