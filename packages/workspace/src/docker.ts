import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Optional task-owned local engine; never changes the user's Docker context. */
export function verificationDockerEnvironment(): NodeJS.ProcessEnv {
  const config = path.resolve('.work/verification-docker.json');
  if (!existsSync(config)) return { ...process.env };
  const stat = lstatSync(config);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('INVALID_VERIFICATION_DOCKER_CONFIG');
  const value: unknown = JSON.parse(readFileSync(config, 'utf8'));
  const socketPath = (value as { socketPath?: unknown })?.socketPath;
  const root = path.resolve('.work');
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)
    || !socketPath.startsWith(root + path.sep) || socketPath.split(path.sep).includes('..')
    || !lstatSync(socketPath).isSocket()) throw new Error('INVALID_VERIFICATION_DOCKER_SOCKET');
  return { ...process.env, DOCKER_HOST: `unix://${socketPath}`, DOCKER_CONTEXT: '',
    DOCKER_CONFIG: path.join(root, 'verification-docker-cli') };
}
