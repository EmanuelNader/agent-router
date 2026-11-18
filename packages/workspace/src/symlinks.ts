import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';

export function assertRelativeLink(target: string): void {
  if (!target || target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
    throw new Error('Symlink target must be a portable relative path');
  }
}

/** Resolve each component, including links followed by .., without reading file bytes. */
export async function validateWorkspaceLink(root: string, relative: string, target: string): Promise<void> {
  assertRelativeLink(target);
  const pending = [...path.posix.dirname(relative).split('/').filter(p => p !== '.'), ...target.split('/')];
  const resolved: string[] = [];
  let links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) throw new Error('Symlink escapes workspace');
      resolved.pop();
      continue;
    }
    if (part === '.git') throw new Error('Symlink targets Git metadata');
    const candidate = path.join(root, ...resolved, part);
    let stat;
    try { stat = await lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (stat?.isSymbolicLink()) {
      if (++links > 40) throw new Error('Symlink cycle or excessive chain');
      const next = await readlink(candidate);
      assertRelativeLink(next);
      pending.unshift(...next.split('/'));
    } else resolved.push(part);
  }
}
