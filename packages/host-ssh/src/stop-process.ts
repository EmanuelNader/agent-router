import { setTimeout as delay } from 'node:timers/promises';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function assertStoppableProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
    throw new Error('SOURCE_AGENT_PID_INVALID: expected the process ID of the source agent');
  }
  if (!isRunning(pid)) throw new Error(`SOURCE_AGENT_NOT_RUNNING: no process ${pid}`);
}

/**
 * Sends SIGTERM to one process and waits for it to exit. It never escalates to SIGKILL: a killed agent
 * may not have flushed its history, so a process that ignores SIGTERM fails the caller instead.
 */
export async function stopProcess(pid: number, timeoutMs = 30_000): Promise<void> {
  assertStoppableProcess(pid);
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`SOURCE_AGENT_STILL_RUNNING: process ${pid} did not exit within ${timeoutMs} ms of SIGTERM`);
    }
    await delay(50);
  }
}
