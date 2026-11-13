import type { OpenCodeClient, SessionTransfer } from './client.js';
import { startIsolatedServer } from './server.js';

export interface RunningAgent {
  client: OpenCodeClient;
  stop: () => Promise<void>;
}

export interface ResumedAgent extends RunningAgent {
  baseUrl: string;
  sessionId: string;
}

/** Pause a pinned OpenCode process and open its saved session in a fresh one. */
export class OpenCodeAdapter {
  /** Export settled history, then stop the process so the workspace can be checkpointed. */
  static async quiesce(agent: RunningAgent, sessionId: string): Promise<SessionTransfer> {
    const transfer = await agent.client.exportSession(sessionId);
    await agent.stop();
    return transfer;
  }

  /** Start a new isolated process and import the checkpoint into the restored workspace. */
  static async resume(workspaceDirectory: string, stateDirectory: string, transfer: SessionTransfer): Promise<ResumedAgent> {
    const server = await startIsolatedServer(workspaceDirectory, stateDirectory);
    try {
      const sessionId = await server.client.importSession(transfer, workspaceDirectory);
      if (sessionId !== transfer.info.id) throw new Error('Restored OpenCode session id does not match the checkpoint');
      return { client: server.client, baseUrl: server.baseUrl, stop: server.stop, sessionId };
    } catch (error) {
      await server.stop();
      throw error;
    }
  }
}
