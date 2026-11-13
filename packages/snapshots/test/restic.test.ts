import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ResticRepository } from '../src/restic.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function directory(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

test('does not put the repository key on the restic command line or in its environment', async () => {
  const root = await directory('router-restic-argv-');
  const argvLog = path.join(root, 'argv.txt');
  const envLog = path.join(root, 'env.txt');
  const binary = path.join(root, 'restic');
  const password = 'file-key-9c2e';
  const leaked = 'parent-leak-7f3a';
  await writeFile(binary, `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
env >> '${envLog}'
if [ "$1" = version ]; then printf '%s\\n' 'restic 0.19.1 compiled with go1.26.4 on linux/amd64'; exit 0; fi
if [ "$1" = --no-cache ] && [ "$2" = init ]; then exit 0; fi
if [ "$1" = --no-cache ] && [ "$2" = backup ]; then printf '%s\\n' '{"message_type":"summary","snapshot_id":"${'a'.repeat(64)}"}'; exit 0; fi
exit 1
`, { mode: 0o755 });
  const keyDir = path.join(root, 'key');
  const source = path.join(root, 'source');
  await mkdir(keyDir); await mkdir(source);
  const passwordFile = path.join(keyDir, 'snapshot.key');
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  process.env.RESTIC_PASSWORD = leaked;
  process.env.AWS_SECRET_ACCESS_KEY = leaked;
  try {
    const stored = await new ResticRepository({ repository: path.join(root, 'repo'), passwordFile, binary }).backup(source);
    const argv = await readFile(argvLog, 'utf8');
    const env = await readFile(envLog, 'utf8');
    expect(stored.snapshotId).toBe('a'.repeat(64));
    expect(argv).not.toContain(password);
    expect(argv).not.toContain(leaked);
    expect(env).toContain(`RESTIC_PASSWORD_FILE=${passwordFile}`);
    expect(env).not.toContain('RESTIC_PASSWORD=');
    expect(env).not.toContain(password);
    expect(env).not.toContain(leaked);
    expect(env).not.toContain('AWS_SECRET_ACCESS_KEY');
  } finally {
    delete process.env.RESTIC_PASSWORD;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  }
});

test('refuses a group-readable key file before starting restic', async () => {
  const root = await directory('router-restic-key-');
  const binary = path.join(root, 'restic');
  const argvLog = path.join(root, 'argv.txt');
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexit 0\n`, { mode: 0o755 });
  const passwordFile = path.join(root, 'snapshot.key');
  await writeFile(passwordFile, 'file-key-9c2e\n', { mode: 0o644 });
  await chmod(passwordFile, 0o644);
  const source = path.join(root, 'source');
  await mkdir(source);
  await expect(new ResticRepository({ repository: path.join(root, 'repo'), passwordFile, binary }).backup(source)).rejects.toThrow('Snapshot key file must not be group or world readable');
  await expect(readFile(argvLog, 'utf8')).rejects.toThrow();
});
