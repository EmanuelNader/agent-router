import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { stopProcess } from '../src/stop-process.js';

async function started(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  return child;
}

test('stopProcess waits for a process that exits on SIGTERM', async () => {
  const child = await started("console.log('ready'); setInterval(() => {}, 1000)");
  await stopProcess(child.pid!);
  expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
});

test('stopProcess fails without killing a process that ignores SIGTERM', async () => {
  const child = await started("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)");
  try {
    await expect(stopProcess(child.pid!, 300)).rejects.toThrow('SOURCE_AGENT_STILL_RUNNING');
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
});

test('stopProcess refuses its own process, its parent and non-PIDs', async () => {
  for (const pid of [process.pid, process.ppid, 1, 0, -5, Number.NaN, 1.5]) {
    await expect(stopProcess(pid)).rejects.toThrow('SOURCE_AGENT_PID_INVALID');
  }
});
