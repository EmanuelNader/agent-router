import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { identifyStoppableProcess, stopProcess } from '../src/stop-process.js';

async function started(script: string) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  return child;
}

test('stopProcess waits for a process that exits on SIGTERM', async () => {
  const child = await started("console.log('ready'); setInterval(() => {}, 1000)");
  await stopProcess(await identifyStoppableProcess(child.pid!));
  expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
});

test('stopProcess fails without killing a process that ignores SIGTERM', async () => {
  const child = await started("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)");
  try {
    await expect(stopProcess(await identifyStoppableProcess(child.pid!), 300)).rejects.toThrow('SOURCE_AGENT_STILL_RUNNING');
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
});

test('stopProcess does not signal a PID whose start time differs from the identified process', async () => {
  const child = await started("console.log('ready'); setInterval(() => {}, 1000)");
  try {
    await stopProcess({ pid: child.pid!, startedAt: 'another start' }, 300);
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
});

test('an exited process that its parent has not reaped counts as stopped', async () => {
  // The shell stays alive without waiting for its child, so the child remains a zombie after SIGTERM.
  const shell = spawn('/bin/sh', ['-c', 'sleep 300 & echo $!; exec sleep 300'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const [line] = await once(shell.stdout!, 'data') as [Buffer];
    const pid = Number(line.toString().trim());
    const target = await identifyStoppableProcess(pid);
    await stopProcess(target, 2_000);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await expect(identifyStoppableProcess(pid)).rejects.toThrow('SOURCE_AGENT_NOT_RUNNING');
  } finally {
    shell.kill('SIGKILL');
    await once(shell, 'exit');
  }
});

test('identifyStoppableProcess refuses its own process, its parent and non-PIDs', async () => {
  for (const pid of [process.pid, process.ppid, 1, 0, -5, Number.NaN, 1.5]) {
    await expect(identifyStoppableProcess(pid)).rejects.toThrow('SOURCE_AGENT_PID_INVALID');
  }
});
