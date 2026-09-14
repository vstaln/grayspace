// Explicit extension: this module is loaded both by Vite and directly by the
// node test runner, and node's ESM resolver does not infer it.
import { attachmentAgent } from './terminalAttachments.ts'

export interface PersistedAgentShape {
  id: string
  command: string
}

/**
 * Which known agent a persisted Code session belongs to, and the command it
 * should start with.
 *
 * The executable decides the identity — persisted metadata can be stale, and a
 * session must never show Codex while launching Claude. The *arguments*,
 * though, belong to the session: a session resuming a conversation
 * (`claude --resume <id>`) has to come back resuming it, not as a blank one.
 *
 * Returns null when nothing in the list matches, meaning the caller should
 * treat it as a custom CLI.
 */
export function resolvePersistedAgent<T extends PersistedAgentShape>(
  agentId: string,
  command: string,
  agents: readonly T[]
): { agent: T; command: string } | null {
  const commandAgentId = attachmentAgent(command)
  const fromCommand = commandAgentId ? agents.find((agent) => agent.id === commandAgentId) : undefined
  if (fromCommand) return { agent: fromCommand, command: command.trim() ? command : fromCommand.command }

  const found = agents.find((agent) => agent.id === agentId)
  if (found && found.command === command) return { agent: found, command }
  // The command says nothing usable (an old wrapper, a hand-edited state
  // file), so the recorded agent stands and starts the way it normally does.
  if (found && agentId !== 'custom') return { agent: found, command: found.command }

  return null
}
