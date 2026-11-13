import { z } from 'zod';

const completedShell = z.object({
  type: z.literal('shell'), status: z.literal('exited'), exit: z.literal(0),
  time: z.object({ completed: z.number().int().positive() }),
  output: z.object({ output: z.string() }),
});

/** Check actual settled output; command text alone can match even after a failure. */
export function requireCompletedShellOutput(messages: unknown[], expectedOutput: string): void {
  const found = messages.some(message => {
    const result = completedShell.safeParse(message);
    return result.success && result.data.output.output === expectedOutput;
  });
  if (!found) throw new Error('Session history does not contain the expected successful shell output');
}
