import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export interface FileReceipt {
  path: string;
  executable: boolean;
  sha256: string;
}

/** Content receipt only: callers must quiesce writers and back up Git/agent state separately. */
export async function hashWorkspace(directory: string): Promise<FileReceipt[]> {
  const root = path.resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a real directory');
  const rows: FileReceipt[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (name === '.git') continue;
      const entry = path.join(relative, name);
      const absolute = path.join(root, entry);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not supported in this fixture: ${entry}`);
      if (stat.isDirectory()) await visit(entry);
      else if (stat.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        rows.push({ path: entry.split(path.sep).join('/'), executable: (stat.mode & 0o111) !== 0, sha256: hash.digest('hex') });
      } else throw new Error(`Unsupported workspace entry: ${entry}`);
    }
  }
  await visit('');
  return rows;
}
