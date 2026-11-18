import { z } from 'zod';

export const pairingAgentKindSchema = z.enum(['opencode', 'codex-cli', 'claude-code']);
export type PairingAgentKind = z.infer<typeof pairingAgentKindSchema>;

const safeSessionNamePattern = /^[A-Za-z0-9._-]{1,64}$/;

export const codexPairingPayloadSchema = z
  .object({
    pairingCode: z.string().min(1).optional(),
    manualPairingCode: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
  })
  .refine(value => Boolean(value.pairingCode || value.manualPairingCode), {
    message: 'Codex pairing response missing pairingCode or manualPairingCode',
  });
export type CodexPairingPayload = z.infer<typeof codexPairingPayloadSchema>;

export function buildRemotePairingCommands(
  agentInput: PairingAgentKind,
  options: { sessionName?: string } = {},
): string[][] {
  const agent = pairingAgentKindSchema.parse(agentInput);
  if (agent === 'opencode') {
    return [['opencode', 'pair', '--remote', '--yes']];
  }
  if (agent === 'codex-cli') {
    return [
      ['codex', 'remote-control', 'start', '--json'],
      ['codex', 'remote-control', 'pair', '--json'],
    ];
  }
  if (options.sessionName !== undefined) {
    if (!safeSessionNamePattern.test(options.sessionName)) {
      throw new Error('Invalid Claude Remote Control sessionName: expected [A-Za-z0-9._-]{1,64}');
    }
    return [['claude', 'remote-control', '--name', options.sessionName]];
  }
  return [['claude', 'remote-control']];
}

export interface RemoteCommandRunner {
  runRemoteCommand(remoteCommand: string[]): Promise<{ stdout: string }>;
}

export interface RemotePairingResult {
  agent: PairingAgentKind;
  rawOutput: string;
  codexPairing?: CodexPairingPayload;
}

export async function runRemotePairingOverSsh(
  runner: RemoteCommandRunner,
  agentInput: PairingAgentKind,
  options: { sessionName?: string } = {},
): Promise<RemotePairingResult> {
  const agent = pairingAgentKindSchema.parse(agentInput);
  const commands = buildRemotePairingCommands(agent, options);
  const outputs: string[] = [];

  for (const cmd of commands) {
    const { stdout } = await runner.runRemoteCommand(cmd);
    outputs.push(stdout.trim());
  }

  const lastOutput = outputs[outputs.length - 1] ?? '';
  if (agent === 'codex-cli') {
    const parsed = codexPairingPayloadSchema.parse(JSON.parse(lastOutput));
    return {
      agent,
      rawOutput: JSON.stringify(parsed),
      codexPairing: parsed,
    };
  }

  return {
    agent,
    rawOutput: lastOutput,
  };
}
