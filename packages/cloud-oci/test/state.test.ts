import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OpenCodeBootstrap } from '../../agent-opencode/src/bootstrap.js';
import { DeployError } from '../src/errors.js';
import { OciDeployState } from '../src/state.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test('state round-trips the password without making the file group-readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-state-'));
  roots.push(root);
  const path = join(root, 'state.json');
  const created = OciDeployState.create();
  await OciDeployState.save(path, created);
  expect((await lstat(path)).mode & 0o077).toBe(0);
  expect(await OciDeployState.load(path)).toEqual(created);
  const script = OpenCodeBootstrap.cloudInit(created.password);
  expect(OciDeployState.passwordFromUserData(Buffer.from(script).toString('base64'))).toBe(created.password);
  await chmod(path, 0o644);
  await expect(OciDeployState.load(path)).rejects.toMatchObject({ code: 'STATE_PERMISSIONS' });
});

test('a replaced instance token does not keep the old instance id', () => {
  const created = OciDeployState.create();
  const cleared = OciDeployState.withoutInstance({ ...created, instanceId: 'ocid1.instance.oc1..old' });
  expect(cleared.instanceId).toBeUndefined();
  expect(cleared.tokens.instance).not.toBe(created.tokens.instance);
  expect(cleared.password).toBe(created.password);
  expect(() => new DeployError('STATE_INVALID').code).not.toThrow();
});
