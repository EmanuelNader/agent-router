import { realpath } from 'node:fs/promises';
import path from 'node:path';

export class SnapshotPaths {
  /** True when child is parent, or parent will contain child even if child does not exist yet. */
  static async isInside(parent: string, child: string): Promise<boolean> {
    const parentReal = await SnapshotPaths.locate(parent);
    const childReal = await SnapshotPaths.locate(child);
    const relative = path.relative(parentReal, childReal);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  static async assertDisjoint(left: string, right: string, message: string): Promise<void> {
    if (await SnapshotPaths.isInside(left, right) || await SnapshotPaths.isInside(right, left)) throw new Error(message);
  }

  /** Real path of target, or of its nearest existing ancestor plus the missing suffix. Does not create anything. */
  private static async locate(target: string): Promise<string> {
    const missing: string[] = [];
    let current = path.resolve(target);
    for (;;) {
      try {
        const found = await realpath(current);
        return missing.length === 0 ? found : path.join(found, ...missing.reverse());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        missing.push(path.basename(current));
        current = parent;
      }
    }
  }
}
