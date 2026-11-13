import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Byte search used to prove checkpoint plaintext did not land in the repository. */
export class SnapshotPrivacy {
  static async contains(directory: string, phrase: string): Promise<boolean> {
    const needle = Buffer.from(phrase);
    return SnapshotPrivacy.visit(directory, needle);
  }

  private static async visit(directory: string, needle: Buffer): Promise<boolean> {
    for (const name of await readdir(directory)) {
      const absolute = path.join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (await SnapshotPrivacy.visit(absolute, needle)) return true;
      } else if (stat.isFile() && (await readFile(absolute)).includes(needle)) return true;
    }
    return false;
  }
}
