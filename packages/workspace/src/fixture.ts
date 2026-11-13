import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Mutable copy of the migration fixture: committed files, a rename, and saved uncommitted work. */
export class MigrationFixture {
  static async prepare(fixtureSource: string, directory: string): Promise<void> {
    await cp(fixtureSource, directory, { recursive: true });
    await chmod(path.join(directory, 'scripts/check.sh'), 0o755);
    await writeFile(path.join(directory, '.gitignore'), 'node_modules\n.cache\n');
    MigrationFixture.git(directory, ['init', '--quiet']);
    MigrationFixture.git(directory, ['add', '.']);
    MigrationFixture.git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
    await writeFile(path.join(directory, 'src/message.txt'), 'unfinished work survives migration\n');
    await writeFile(path.join(directory, 'notes.txt'), 'keep this untracked note\n');
    await writeFile(path.join(directory, '.workspace-note'), 'keep this hidden note\n');
    await rename(path.join(directory, 'README.md'), path.join(directory, 'PROJECT.md'));
    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await writeFile(path.join(directory, 'node_modules', 'skipped.txt'), 'dependency cache stays behind\n');
    await writeFile(path.join(directory, 'node_modules', 'via-link.txt'), 'symlink cache stays behind\n');
    await mkdir(path.join(directory, '.cache'), { recursive: true });
    await writeFile(path.join(directory, '.cache', 'tmp'), 'tool cache stays behind\n');
    await mkdir(path.join(directory, 'packages', 'foo', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(directory, 'packages', 'foo', 'keep.txt'), 'nested source file survives\n');
    await writeFile(path.join(directory, 'packages', 'foo', 'node_modules', 'pkg', 'index.js'), 'nested dependency cache stays behind\n');
    await mkdir(path.join(directory, 'packages', 'foo', '.cache'), { recursive: true });
    await writeFile(path.join(directory, 'packages', 'foo', '.cache', 'tmp'), 'nested tool cache stays behind\n');
    await mkdir(path.join(directory, 'packages', 'bar'), { recursive: true });
    await symlink(path.join('..', '..', 'node_modules'), path.join(directory, 'packages', 'bar', 'node_modules'));
  }

  static git(directory: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, HOME: directory, GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      },
    });
  }
}
