import type { Hooks, Plugin, PluginInput } from '@opencode-ai/plugin'
import type { Event } from '@opencode-ai/sdk'

export const DEFAULT_MAX_RETRIES = 10

export function parseCodeBlock(input: string): string | null {
  const codeBlockRegex = /(?:```|~~~)([a-zA-Z0-9_-]*)\n([\s\S]*?)(?:```|~~~)/
  const match = input.match(codeBlockRegex)
  if (match && match[2]) {
    return match[2].trim()
  }
  return null
}

interface SessionEntry {
  command: string
  retries: number
}

export class CompletionCheckStore {
  private entries = new Map<string, SessionEntry>()
  private maxRetries: number

  constructor(maxRetries = DEFAULT_MAX_RETRIES) {
    this.maxRetries = maxRetries
  }

  set(sessionID: string, command: string): void {
    this.entries.set(sessionID, { command, retries: 0 })
  }

  get(sessionID: string): string | undefined {
    return this.entries.get(sessionID)?.command
  }

  getEntry(sessionID: string): SessionEntry | undefined {
    return this.entries.get(sessionID)
  }

  incrementRetries(sessionID: string): number {
    const entry = this.entries.get(sessionID)
    if (!entry) {
      return -1
    }
    entry.retries++
    return entry.retries
  }

  retriesExhausted(sessionID: string): boolean {
    const entry = this.entries.get(sessionID)
    if (!entry) {
      return false
    }
    return entry.retries >= this.maxRetries
  }

  delete(sessionID: string): void {
    this.entries.delete(sessionID)
  }

  has(sessionID: string): boolean {
    return this.entries.has(sessionID)
  }

  clear(): void {
    this.entries.clear()
  }

  getMaxRetries(): number {
    return this.maxRetries
  }
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function executeCommand($: PluginInput['$'], command: string, cwd: string): Promise<CommandResult> {
  try {
    const result = await $`${command}`.nothrow().quiet().cwd(cwd)
    return {
      exitCode: result.exitCode,
      stdout: result.text(),
      stderr: result.stderr.toString(),
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

export function buildFailureMessage(result: CommandResult): string {
  let message = 'you are not yet finished:\n'
  if (result.stdout) {
    message += `\nstdout:\n${result.stdout}`
  }
  if (result.stderr) {
    message += `\nstderr:\n${result.stderr}`
  }
  if (!result.stdout && !result.stderr) {
    message += `\nCommand exited with code ${result.exitCode}`
  }
  return message
}

export const CompletionCheckCommandPlugin: Plugin = async (input, options) => {
  const { client, $ } = input
  const maxRetries = typeof options?.maxRetries === 'number' ? options.maxRetries : DEFAULT_MAX_RETRIES
  const store = new CompletionCheckStore(maxRetries)

  const processing = new Set<string>()

  const hooks: Hooks = {
    config: async (config) => {
      if (!config.command) {
        config.command = {}
      }
      if (!config.command['completion-check-command']) {
        config.command['completion-check-command'] = {
          template:
            'The user wants to verify task completion after you finish. Run your task, and when you are done, a completion check will automatically run to verify your work.\n\nThe completion check command is:\n{{arguments}}',
          description:
            'Register a shell command that will be executed after the agent finishes to verify task completion. Include a markdown code block with the shell command to run.',
        }
      }
    },

    'command.execute.before': async (input, output) => {
      if (input.command !== 'completion-check-command') {
        return
      }

      const command = parseCodeBlock(input.arguments)
      if (!command) {
        try {
          await client.tui.showToast({
            body: {
              title: 'Completion Check',
              message:
                "I couldn't find a code block in your message. Please include a markdown code block with the shell command to run. For example:\n\n```bash\n./check.sh\n```",
              variant: 'warning',
              duration: 10000,
            },
          })
        } catch {
          // Ignore feedback errors
        }
        return
      }

      store.set(input.sessionID, command)

      try {
        await client.tui.showToast({
          body: {
            title: 'Completion Check',
            message: `Registered! When the agent finishes, this command will be run to verify completion:\n\n\`\`\`bash\n${command}\n\`\`\``,
            variant: 'success',
            duration: 10000,
          },
        })
      } catch {
        // Ignore feedback errors
      }
    },

    event: async ({ event }) => {
      if (event.type !== 'session.idle') {
        return
      }

      const sessionID = (event as Extract<Event, { type: 'session.idle' }>).properties.sessionID
      const command = store.get(sessionID)
      if (!command) {
        return
      }

      if (processing.has(sessionID)) {
        return
      }
      processing.add(sessionID)

      try {
        const result = await executeCommand($, command, input.directory)

        if (result.exitCode === 0) {
          store.delete(sessionID)
          return
        }

        if (store.retriesExhausted(sessionID)) {
          store.delete(sessionID)
          return
        }

        store.incrementRetries(sessionID)

        const failureMessage = buildFailureMessage(result)

        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: 'text',
                text: failureMessage,
              },
            ],
          },
        })
      } finally {
        processing.delete(sessionID)
      }
    },
  }

  return hooks
}

export default CompletionCheckCommandPlugin
