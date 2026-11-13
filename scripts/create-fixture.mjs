import { cp, mkdir, rename, writeFile, chmod, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.umask(0o077);
const destination = path.join(repository, '.work/source');
try { await access(destination); console.error('Fixture already exists: .work/source. Preserve or move it before creating another.'); process.exit(1); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
await cp(path.join(repository, 'fixtures/workspace'), destination, { recursive: true, errorOnExist: true, force: false });
await chmod(path.join(destination, 'scripts/check.sh'), 0o755);
const git = (...args) => execFileSync('git', args, {
  cwd: destination, stdio: 'pipe',
  env: { PATH: process.env.PATH, HOME: destination, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
});
git('init', '-q');
git('config', 'user.name', 'Agent Router Fixture');
git('config', 'user.email', 'fixture@example.invalid');
git('add', '.');
git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
await writeFile(path.join(destination, 'src/message.txt'), 'unfinished work survives migration\n');
await writeFile(path.join(destination, 'notes.txt'), 'keep this untracked note\n');
await writeFile(path.join(destination, '.workspace-note'), 'keep this hidden note\n');
await rename(path.join(destination, 'README.md'), path.join(destination, 'PROJECT.md'));
console.log('Created .work/source with committed baseline, unfinished edits, untracked files and a rename.');
