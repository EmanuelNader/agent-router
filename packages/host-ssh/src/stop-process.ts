import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Start time of a live process, or undefined when the PID is free or only a zombie awaiting its parent. */
async function liveProcessStart(pid: number): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } }));
  } catch (error) {
    // ps exits 1 with no output when the PID does not exist.
    if ((error as { code?: unknown }).code === 1) return undefined;
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
