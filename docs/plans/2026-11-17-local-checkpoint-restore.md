# Milestone 1: Local Checkpoint & Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture an application-consistent, AES-256-GCM / `restic`-encrypted checkpoint of a quiesced workspace (including `.git`, modified, renamed, hidden, and untracked files) plus exported OpenCode `2.2.7` sessions, and verify full restoration into a fresh target directory and isolated agent state while failing closed on tampering or version mismatches.

**Architecture:** `packages/snapshots` introduces a versioned Zod checkpoint manifest (`manifest.ts`), an encrypted bundle store abstraction (`store.ts` with a built-in Node `crypto` AES-256-GCM local store for zero-external-binary CI determinism plus an optional `restic` CLI backend in `restic.ts`), and an orchestrator (`checkpoint.ts`) that exports OpenCode sessions, stops/fences the source server, hashes the quiesced workspace via `hashWorkspace`, snapshots Git state, archives the bundle, and verifies every receipt upon restore before importing sessions into a fresh isolated OpenCode server.

**Tech Stack:** Node 24 (`node:crypto`, `node:fs/promises`, `node:child_process`, `node:zlib`), `pnpm@11.25.0`, TypeScript `7.0.2` (`NodeNext`), `zod@4.6.7`, `vitest@5.1.0`, `@opencode/cli@2.2.7`, optional `restic` CLI.

## Global Constraints

- Use Node 24 and `pnpm@11.25.0` with `--frozen-lockfile`; add zero new npm dependencies unless strictly necessary.
- Keep all temporary test and round-trip directories mode `0700` and secret/archive files mode `0600`; never print transcripts, encryption keys, or passwords to stdout/stderr or `docs/evidence/`.
- Preserve strict separation between `packages/workspace`, `packages/agent-opencode`, and `packages/snapshots`.
- Stop/fence the source OpenCode process *before* hashing and archiving the workspace so no concurrent writer mutates files mid-capture.
- Reject symlinks, path-traversal entries (`..`, absolute paths), wrong `schemaVersion` or `opencodeVersion`, corrupted ciphertext, and mismatched `FileReceipt` or Git state *before* starting a target OpenCode server.
- Run `pnpm check`, `pnpm agent:probe`, and `pnpm agent:roundtrip` before claiming completion.

---

### Task 1: Versioned Checkpoint Manifest & Path Safety Validation

**Files:**
- Create: `packages/snapshots/src/manifest.ts`
- Test: `packages/snapshots/test/manifest.test.ts`

**Interfaces:**
- Consumes: `FileReceipt` from `../../workspace/src/manifest.js`, `OPENCODE_VERSION` from `../../agent-opencode/src/server.js`, `SessionTransfer` from `../../agent-opencode/src/client.js`.
- Produces: `checkpointManifestSchema`, `CheckpointManifest`, `assertSafeRelativePath(entryPath: string): string`.

- [ ] **Step 1: Write the failing manifest schema and path-validation tests**

Create `packages/snapshots/test/manifest.test.ts`:

```typescript
import { expect, test } from 'vitest';
import { assertSafeRelativePath, checkpointManifestSchema } from '../src/manifest.js';

const validManifest = {
  schemaVersion: 1 as const,
  checkpointId: 'chk_0123456789abcdef',
  createdAt: '2026-11-17T22:00:00.000Z',
  architecture: 'arm64',
  opencodeVersion: '2.2.7' as const,
  sessionIds: ['ses_fixture1'],
  git: {
    present: true,
    head: '0123456789abcdef0123456789abcdef01234567',
    statusPorcelain: ' M src/message.txt\n?? notes.txt\n',
    indexStage: '100644 0123456789abcdef0123456789abcdef01234567 0\tsrc/message.txt\n',
  },
  workspaceFiles: [
    {
      path: 'src/message.txt',
      executable: false,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  ],
};

test('accepts a valid v1 checkpoint manifest', () => {
  expect(checkpointManifestSchema.parse(validManifest)).toEqual(validManifest);
});

test('rejects wrong schemaVersion, wrong opencodeVersion, or unsafe relative paths', () => {
  expect(() => checkpointManifestSchema.parse({ ...validManifest, schemaVersion: 2 })).toThrow();
  expect(() => checkpointManifestSchema.parse({ ...validManifest, opencodeVersion: '1.0.0' })).toThrow();
  expect(() =>
    checkpointManifestSchema.parse({
      ...validManifest,
      workspaceFiles: [{ ...validManifest.workspaceFiles[0]!, path: '../escape.txt' }],
    }),
  ).toThrow();
});

test('assertSafeRelativePath rejects traversal, absolute, empty, and NUL paths', () => {
  expect(assertSafeRelativePath('.git/HEAD')).toBe('.git/HEAD');
  expect(() => assertSafeRelativePath('')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('/etc/passwd')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('a/../b')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('a\0b')).toThrow(/relative path/i);
});
```

- [ ] **Step 2: Run Vitest to verify it fails**

Run: `pnpm vitest run packages/snapshots/test/manifest.test.ts`
Expected: FAIL (`Cannot find module '../src/manifest.js'`)

- [ ] **Step 3: Implement `packages/snapshots/src/manifest.ts`**

Create `packages/snapshots/src/manifest.ts`:

```typescript
import path from 'node:path';
import { z } from 'zod';
import { OPENCODE_VERSION } from '../../agent-opencode/src/server.js';

export function assertSafeRelativePath(entryPath: string): string {
  if (
    !entryPath ||
    entryPath.includes('\0') ||
    entryPath.includes('\\') ||
    entryPath.startsWith('/') ||
    path.posix.isAbsolute(entryPath)
  ) {
    throw new Error(`Unsafe relative path in checkpoint: ${entryPath}`);
  }
  const segments = entryPath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe relative path in checkpoint: ${entryPath}`);
  }
  return entryPath;
}

const safePathSchema = z.string().transform(value => assertSafeRelativePath(value));
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const fileReceiptSchema = z.object({
  path: safePathSchema,
  executable: z.boolean(),
  sha256: sha256Schema,
});

export const gitStateSchema = z.discriminatedUnion('present', [
  z.object({
    present: z.literal(true),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    statusPorcelain: z.string(),
    indexStage: z.string(),
  }),
  z.object({ present: z.literal(false) }),
]);

export const checkpointManifestSchema = z.object({
  schemaVersion: z.literal(1),
  checkpointId: z.string().regex(/^chk_[a-f0-9]{16,64}$/),
  createdAt: z.iso.datetime(),
  architecture: z.string().min(1),
  opencodeVersion: z.literal(OPENCODE_VERSION),
  sessionIds: z.array(z.string().min(1)),
  git: gitStateSchema,
  workspaceFiles: z.array(fileReceiptSchema),
});

export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/snapshots/test/manifest.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/snapshots/src/manifest.ts packages/snapshots/test/manifest.test.ts
git commit -m "Add versioned checkpoint manifest and path validation"
```

---

### Task 2: Authenticated Encrypted Snapshot Store (AES-256-GCM + Optional `restic` CLI Adapter)

**Files:**
- Create: `packages/snapshots/src/store.ts`
- Create: `packages/snapshots/src/restic.ts`
- Test: `packages/snapshots/test/store.test.ts`

**Interfaces:**
- Consumes: `assertSafeRelativePath` from `./manifest.js`.
- Produces: `SnapshotEntry`, `SnapshotStore`, `LocalEncryptedStore`, `isResticAvailable(): boolean`, `ResticRepositoryStore`.

- [ ] **Step 1: Write failing encryption/tamper/symlink store tests**

Create `packages/snapshots/test/store.test.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LocalEncryptedStore } from '../src/store.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('encrypts entries at rest with AES-256-GCM and restores exact bytes and modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-store-'));
  tempDirs.push(root);
  const key = randomBytes(32);
  const store = new LocalEncryptedStore(join(root, 'repo'), key);

  await store.put('chk_0123456789abcdef', [
    { path: 'scripts/check.sh', executable: true, data: Buffer.from('#!/bin/sh\necho ok\n') },
    { path: 'secret-phrase.txt', executable: false, data: Buffer.from('plaintext-marker-9912') },
  ]);

  const rawCiphertext = await readFile(join(root, 'repo', 'chk_0123456789abcdef.enc'));
  expect(rawCiphertext.includes(Buffer.from('plaintext-marker-9912'))).toBe(false);

  const restored = await store.get('chk_0123456789abcdef');
  expect(restored).toHaveLength(2);
  expect(restored[0]?.executable).toBe(true);
  expect(restored[1]?.data.toString('utf8')).toBe('plaintext-marker-9912');
});

test('rejects tampered ciphertext and wrong encryption keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-store-'));
  tempDirs.push(root);
  const key = randomBytes(32);
  const store = new LocalEncryptedStore(join(root, 'repo'), key);
  await store.put('chk_0123456789abcdef', [
    { path: 'a.txt', executable: false, data: Buffer.from('hello') },
  ]);

  const wrongKeyStore = new LocalEncryptedStore(join(root, 'repo'), randomBytes(32));
  await expect(wrongKeyStore.get('chk_0123456789abcdef')).rejects.toThrow(/decrypt/i);

  const archivePath = join(root, 'repo', 'chk_0123456789abcdef.enc');
  const bytes = await readFile(archivePath);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff);
  await writeFile(archivePath, bytes);
  await expect(store.get('chk_0123456789abcdef')).rejects.toThrow(/decrypt/i);
});
```

- [ ] **Step 2: Run Vitest to verify failure**

Run: `pnpm vitest run packages/snapshots/test/store.test.ts`
Expected: FAIL (`Cannot find module '../src/store.js'`)

- [ ] **Step 3: Implement `packages/snapshots/src/store.ts` and `packages/snapshots/src/restic.ts`**

Create `packages/snapshots/src/store.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { z } from 'zod';
import { assertSafeRelativePath } from './manifest.js';

export interface SnapshotEntry {
  path: string;
  executable: boolean;
  data: Buffer;
}

export interface SnapshotStore {
  put(checkpointId: string, entries: SnapshotEntry[]): Promise<void>;
  get(checkpointId: string): Promise<SnapshotEntry[]>;
}

const idSchema = z.string().regex(/^chk_[a-f0-9]{16,64}$/);
const wireEntrySchema = z.object({
  path: z.string().transform(value => assertSafeRelativePath(value)),
  executable: z.boolean(),
  base64: z.string(),
});
const wireBundleSchema = z.object({
  version: z.literal(1),
  entries: z.array(wireEntrySchema),
});

export class LocalEncryptedStore implements SnapshotStore {
  private readonly directory: string;
  private readonly key: Buffer;

  constructor(directory: string, key: Buffer) {
    if (key.byteLength !== 32) throw new Error('Snapshot encryption requires a 32-byte AES-256 key');
    this.directory = resolve(directory);
    this.key = Buffer.from(key);
  }

  async put(checkpointId: string, entries: SnapshotEntry[]): Promise<void> {
    const id = idSchema.parse(checkpointId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      version: 1,
      entries: entries.map(entry => ({
        path: assertSafeRelativePath(entry.path),
        executable: entry.executable,
        base64: entry.data.toString('base64'),
      })),
    });
    const compressed = brotliCompressSync(Buffer.from(payload, 'utf8'));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const record = Buffer.concat([Buffer.from('AR01'), iv, tag, encrypted]);
    await writeFile(join(this.directory, `${id}.enc`), record, { mode: 0o600, flag: 'wx' });
  }

  async get(checkpointId: string): Promise<SnapshotEntry[]> {
    const id = idSchema.parse(checkpointId);
    const record = await readFile(join(this.directory, `${id}.enc`));
    if (record.byteLength < 32 || record.subarray(0, 4).toString('ascii') !== 'AR01') {
      throw new Error('Cannot decrypt invalid checkpoint container');
    }
    const iv = record.subarray(4, 16);
    const tag = record.subarray(16, 32);
    const ciphertext = record.subarray(32);
    let compressed: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(id, 'utf8'));
      decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Cannot decrypt checkpoint: authentication failed');
    }
    const parsed = wireBundleSchema.parse(JSON.parse(brotliDecompressSync(compressed).toString('utf8')));
    return parsed.entries.map(entry => ({
      path: entry.path,
      executable: entry.executable,
      data: Buffer.from(entry.base64, 'base64'),
    }));
  }
}
```

Create `packages/snapshots/src/restic.ts` (optional CLI adapter when `restic` is installed locally or pointing at S3/R2/OCI Object Storage):

```typescript
import { execFileSync } from 'node:child_process';

export function isResticAvailable(): boolean {
  try {
    return execFileSync('restic', ['version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).startsWith('restic ');
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/snapshots/test/store.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/snapshots/src/store.ts packages/snapshots/src/restic.ts packages/snapshots/test/store.test.ts
git commit -m "Add authenticated AES-256-GCM snapshot store"
```

---

### Task 3: Quiesced Workspace + OpenCode Session Capture & Verified Restore

**Files:**
- Create: `packages/snapshots/src/checkpoint.ts`
- Test: `packages/snapshots/test/checkpoint.test.ts`
- Create: `scripts/checkpoint-roundtrip.ts`

**Interfaces:**
- Consumes: `hashWorkspace` from `../../workspace/src/manifest.js`, `OpenCodeClient` / `SessionTransfer` from `../../agent-opencode/src/client.js`, `OPENCODE_VERSION` / `startIsolatedServer` from `../../agent-opencode/src/server.js`, `checkpointManifestSchema` / `CheckpointManifest` from `./manifest.js`, `SnapshotStore` / `SnapshotEntry` from `./store.js`.
- Produces: `captureCheckpoint(...)` and `restoreCheckpoint(...)`.

- [ ] **Step 1: Write failing end-to-end checkpoint & restore tests (including corruption rejection)**

Create `packages/snapshots/test/checkpoint.test.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { captureCheckpoint, restoreCheckpoint } from '../src/checkpoint.js';
import { LocalEncryptedStore, type SnapshotEntry, type SnapshotStore } from '../src/store.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

test('captures and restores dirty Git workspace, executable bits, and exported sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-checkpoint-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'README.md'), 'initial\n');
  await writeFile(join(source, 'scripts/run.sh'), '#!/bin/sh\necho ok\n');
  await chmod(join(source, 'scripts/run.sh'), 0o755);

  git(source, ['init', '-q']);
  git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.']);
  git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);

  await rename(join(source, 'README.md'), join(source, 'PROJECT.md'));
  await writeFile(join(source, '.hidden-note'), 'keep hidden\n');
  await writeFile(join(source, 'untracked.txt'), 'keep untracked\n');

  const store = new LocalEncryptedStore(join(root, 'store'), randomBytes(32));
  const fakeSessions = [{ info: { id: 'ses_1', title: 'fixture' }, messages: [{ type: 'shell', exit: 0 }] }];
  let stopped = false;

  const manifest = await captureCheckpoint({
    workspace: source,
    store,
    exportSessions: async () => fakeSessions,
    quiesceSource: async () => { stopped = true; },
  });

  expect(stopped).toBe(true);
  const imported: { sessionId: string; directory: string }[] = [];
  const restored = await restoreCheckpoint({
    checkpointId: manifest.checkpointId,
    targetWorkspace: target,
    store,
    importSession: async (transfer, directory) => {
      imported.push({ sessionId: transfer.info.id, directory });
      return transfer.info.id;
    },
  });

  expect(restored.checkpointId).toBe(manifest.checkpointId);
  expect(imported).toEqual([{ sessionId: 'ses_1', directory: target }]);
  expect(await hashWorkspace(target)).toEqual(await hashWorkspace(source));
  expect(git(target, ['rev-parse', 'HEAD'])).toBe(git(source, ['rev-parse', 'HEAD']));
  expect(git(target, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
    git(source, ['status', '--porcelain=v1', '--untracked-files=all']),
  );
});

test('refuses to import sessions if restored file hashes do not match the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-checkpoint-corrupt-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'file.txt'), 'expected-bytes');

  const memory = new Map<string, SnapshotEntry[]>();
  const corruptingStore: SnapshotStore = {
    async put(id, entries) {
      memory.set(
        id,
        entries.map(entry =>
          entry.path === 'workspace/file.txt' ? { ...entry, data: Buffer.from('corrupted-bytes') } : entry,
        ),
      );
    },
    async get(id) {
      return memory.get(id) ?? [];
    },
  };

  const manifest = await captureCheckpoint({
    workspace: source,
    store: corruptingStore,
    exportSessions: async () => [{ info: { id: 'ses_never' }, messages: [] }],
    quiesceSource: async () => {},
  });

  let importCalled = false;
  await expect(
    restoreCheckpoint({
      checkpointId: manifest.checkpointId,
      targetWorkspace: join(root, 'target'),
      store: corruptingStore,
      importSession: async transfer => {
        importCalled = true;
        return transfer.info.id;
      },
    }),
  ).rejects.toThrow(/manifest|hash/i);
  expect(importCalled).toBe(false);
});
```

- [ ] **Step 2: Run Vitest to verify failure**

Run: `pnpm vitest run packages/snapshots/test/checkpoint.test.ts`
Expected: FAIL (`Cannot find module '../src/checkpoint.js'`)

- [ ] **Step 3: Implement `packages/snapshots/src/checkpoint.ts`**

Create `packages/snapshots/src/checkpoint.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SessionTransfer } from '../../agent-opencode/src/client.js';
import { OPENCODE_VERSION } from '../../agent-opencode/src/server.js';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { assertSafeRelativePath, checkpointManifestSchema, type CheckpointManifest } from './manifest.js';
import type { SnapshotEntry, SnapshotStore } from './store.js';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

async function inspectGit(workspace: string): Promise<CheckpointManifest['git']> {
  try {
    const stat = await lstat(path.join(workspace, '.git'));
    if (!stat.isDirectory()) throw new Error('Linked Git worktrees or .git files are unsupported in v1 checkpoints');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
    throw error;
  }
  return {
    present: true,
    head: runGit(workspace, ['rev-parse', 'HEAD']).trim(),
    statusPorcelain: runGit(workspace, ['status', '--porcelain=v1', '--untracked-files=all']),
    indexStage: runGit(workspace, ['ls-files', '--stage']),
  };
}

async function collectAllFiles(root: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const abs = path.join(root, rel);
      const stat = await lstat(abs);
      if (stat.isSymbolicLink()) throw new Error(`Symlink unsupported in checkpoint: ${rel}`);
      if (stat.isDirectory()) await visit(rel);
      else if (stat.isFile()) {
        entries.push({
          path: `workspace/${assertSafeRelativePath(rel)}`,
          executable: (stat.mode & 0o111) !== 0,
          data: await readFile(abs),
        });
      } else throw new Error(`Unsupported special file in checkpoint: ${rel}`);
    }
  }
  await visit('');
  return entries;
}

export async function captureCheckpoint(options: {
  workspace: string;
  store: SnapshotStore;
  exportSessions: () => Promise<SessionTransfer[]>;
  quiesceSource: () => Promise<void>;
}): Promise<CheckpointManifest> {
  const root = path.resolve(options.workspace);
  const sessions = await options.exportSessions();
  // Stop/fence source before reading workspace bytes so no active turn mutates files mid-capture.
  await options.quiesceSource();

  const workspaceFiles = await hashWorkspace(root);
  const git = await inspectGit(root);
  const checkpointId = `chk_${randomBytes(16).toString('hex')}`;
  const manifest: CheckpointManifest = checkpointManifestSchema.parse({
    schemaVersion: 1,
    checkpointId,
    createdAt: new Date().toISOString(),
    architecture: process.arch,
    opencodeVersion: OPENCODE_VERSION,
    sessionIds: sessions.map(session => session.info.id),
    git,
    workspaceFiles,
  });

  const files = await collectAllFiles(root);
  files.push(
    { path: 'meta/manifest.json', executable: false, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'meta/sessions.json', executable: false, data: Buffer.from(JSON.stringify(sessions), 'utf8') },
  );
  await options.store.put(checkpointId, files);
  return manifest;
}

const sessionsArraySchema = z.array(
  z.object({ info: z.object({ id: z.string().min(1) }).passthrough(), messages: z.array(z.unknown()) }).passthrough(),
);

export async function restoreCheckpoint(options: {
  checkpointId: string;
  targetWorkspace: string;
  store: SnapshotStore;
  importSession: (transfer: SessionTransfer, directory: string) => Promise<string>;
}): Promise<CheckpointManifest> {
  const target = path.resolve(options.targetWorkspace);
  try {
    await access(target);
    throw new Error(`Target workspace already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const entries = await options.store.get(options.checkpointId);
  const manifestEntry = entries.find(entry => entry.path === 'meta/manifest.json');
  const sessionsEntry = entries.find(entry => entry.path === 'meta/sessions.json');
  if (!manifestEntry || !sessionsEntry) throw new Error('Checkpoint bundle is missing metadata');

  const manifest = checkpointManifestSchema.parse(JSON.parse(manifestEntry.data.toString('utf8')));
  if (manifest.checkpointId !== options.checkpointId) throw new Error('Checkpoint ID mismatch');
  const sessions = sessionsArraySchema.parse(JSON.parse(sessionsEntry.data.toString('utf8')));

  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) {
      if (!entry.path.startsWith('workspace/')) continue;
      const rel = assertSafeRelativePath(entry.path.slice('workspace/'.length));
      const destination = path.join(target, rel);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.data, { mode: entry.executable ? 0o755 : 0o600, flag: 'wx' });
      if (entry.executable) await chmod(destination, 0o755);
    }

    const actualHashes = await hashWorkspace(target);
    if (JSON.stringify(actualHashes) !== JSON.stringify(manifest.workspaceFiles)) {
      throw new Error('Restored workspace file hashes do not match checkpoint manifest');
    }
    const actualGit = await inspectGit(target);
    if (JSON.stringify(actualGit) !== JSON.stringify(manifest.git)) {
      throw new Error('Restored Git working tree does not match checkpoint manifest');
    }

    for (const session of sessions) {
      const importedId = await options.importSession(session, target);
      if (importedId !== session.info.id) throw new Error('Imported session ID did not match checkpoint');
    }
    return manifest;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/snapshots/test/checkpoint.test.ts && pnpm check`
Expected: PASS

- [ ] **Step 5: Add live OpenCode `checkpoint:roundtrip` verification script & evidence doc**

Create `scripts/checkpoint-roundtrip.ts`:

```typescript
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireCompletedShellOutput } from '../packages/agent-opencode/src/history.js';
import { startIsolatedServer } from '../packages/agent-opencode/src/server.js';
import { captureCheckpoint, restoreCheckpoint } from '../packages/snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../packages/snapshots/src/store.js';

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/checkpoint-'));
const source = join(run, 'source');
const target = join(run, 'target');
const git = (directory: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: run, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });

let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
try {
  await cp(resolve('fixtures/workspace'), source, { recursive: true });
  git(source, ['init', '--quiet']);
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  await writeFile(join(source, 'src/message.txt'), 'unfinished edits\n');
  await writeFile(join(source, '.workspace-note'), 'hidden and untracked\n');
  await rename(join(source, 'README.md'), join(source, 'PROJECT.md'));

  server = await startIsolatedServer(source, join(run, 'source-agent'));
  const sessionId = await server.client.createSession(source, 'Encrypted checkpoint fixture');
  await server.client.runShellCommand(sessionId, "printf 'router-checkpoint-fixture\\n'");

  const store = new LocalEncryptedStore(join(run, 'store'), randomBytes(32));
  const manifest = await captureCheckpoint({
    workspace: source,
    store,
    exportSessions: async () => [await server!.client.exportSession(sessionId)],
    quiesceSource: async () => {
      await server!.stop();
      server = undefined;
    },
  });

  server = await startIsolatedServer(run, join(run, 'target-agent'));
  await restoreCheckpoint({
    checkpointId: manifest.checkpointId,
    targetWorkspace: target,
    store,
    importSession: (transfer, directory) => server!.client.importSession(transfer, directory),
  });

  const restored = await server.client.exportSession(sessionId);
  assert.equal((restored.info.location as { directory?: unknown } | undefined)?.directory, target);
  requireCompletedShellOutput(restored.messages, 'router-checkpoint-fixture\n');
  console.log(JSON.stringify({ status: 'PASS', encryptedAtRest: true, verifiedManifest: true, sessionId: 'PRESERVED' }, null, 2));
} finally {
  await server?.stop();
  await rm(run, { recursive: true, force: true });
}
```

Add `"checkpoint:roundtrip": "tsx scripts/checkpoint-roundtrip.ts"` to `package.json` scripts and `.github/workflows/ci.yml`, run `pnpm check && pnpm agent:probe && pnpm agent:roundtrip && pnpm checkpoint:roundtrip`, and record the sanitized receipt in `docs/evidence/01-local-restore.md`.

- [ ] **Step 6: Commit**

```bash
git add packages/snapshots scripts/checkpoint-roundtrip.ts package.json .github/workflows/ci.yml docs/evidence/01-local-restore.md
git commit -m "Implement encrypted local workspace and OpenCode checkpoint restore"
```
