import { realpath } from 'node:fs/promises';
import path from 'node:path';

export class SnapshotPaths {
  static async isInside(parent: string, child: string): Promise<boolean> {
    const parentReal = await realpath(parent);
    const childReal = await realpath(child);
    const relative = path.relative(parentReal, childReal);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  static async assertDisjoint(left: string, right: string, message: string): Promise<void> {
    if (await SnapshotPaths.isInside(left, right) || await SnapshotPaths.isInside(right, left)) throw new Error(message);
  }
}
