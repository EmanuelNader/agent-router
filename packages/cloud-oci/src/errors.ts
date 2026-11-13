/** Stable failure code. The message is the code so logs do not carry OCIDs or credentials. */
export class DeployError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'DeployError';
    this.code = code;
    this.details = details;
  }
}
