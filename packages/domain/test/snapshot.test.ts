import { expect, test } from 'vitest';
import { OPENCODE_VERSION } from '../../agent-opencode/src/server.js';
import { SnapshotError, SnapshotIdentity, SnapshotManifest } from '../src/snapshot.js';

const host = SnapshotIdentity.current(OPENCODE_VERSION, '11111111-1111-4111-8111-111111111111');
const manifest = SnapshotManifest.create({
  workspaceId: host.workspaceId,
  architecture: host.architecture,
  platform: host.platform,
  agentVersion: host.agentVersion,
  runtimeDigest: host.runtimeDigest,
  snapshotId: 'a'.repeat(64),
  archivePath: '/tmp/router-checkpoint',
  files: [],
  session: { id: 'ses_contract', sha256: 'b'.repeat(64) },
});

test('accepts a versioned manifest for this host', () => {
  expect(SnapshotManifest.parse(manifest)).toEqual(manifest);
  expect(() => SnapshotManifest.assertCompatible(manifest, host)).not.toThrow();
  expect(SnapshotManifest.sameBinding(manifest, SnapshotManifest.binding(manifest))).toBe(true);
});

test('refuses a different snapshot format before treating it as restorable', () => {
  expect(() => SnapshotManifest.parse({ ...manifest, formatVersion: 2 })).toThrow(SnapshotError);
  try { SnapshotManifest.parse({ ...manifest, formatVersion: 2 }); }
  catch (error) {
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).code).toBe('WRONG_VERSION');
    expect((error as SnapshotError).message).toBe('Snapshot format version 2 is not supported (expected 1)');
  }
});

test('refuses an incomplete manifest and a mismatched agent version', () => {
  const { snapshotId, ...incomplete } = manifest;
  void snapshotId;
  expect(() => SnapshotManifest.parse(incomplete)).toThrow(SnapshotError);
  try { SnapshotManifest.parse(incomplete); }
  catch (error) {
    expect((error as SnapshotError).code).toBe('INCOMPLETE');
    expect((error as SnapshotError).message).toBe('Snapshot manifest is incomplete');
  }
  try { SnapshotManifest.assertCompatible({ ...manifest, agentVersion: '9.9.9' }, host); }
  catch (error) {
    expect((error as SnapshotError).code).toBe('WRONG_VERSION');
    expect((error as SnapshotError).message).toBe('Snapshot agent version 9.9.9 does not match pinned OpenCode 2.2.7');
    return;
  }
  throw new Error('Mismatched agent version was accepted');
});

test('does not treat a relabeled workspace id as the same sealed manifest', () => {
  const relabeled = { ...manifest, workspaceId: '22222222-2222-4222-8222-222222222222' };
  expect(SnapshotManifest.sameBinding(relabeled, SnapshotManifest.binding(manifest))).toBe(false);
});
