import type { Plugin } from '@opencode/plugin'
import {
  buildFailureMessage,
  CompletionCheckStore,
  DEFAULT_MAX_RETRIES,
  executeCommand,
  isUsageLimitError,
  parseCodeBlock,
  readDefaultCommand,
} from './completion-check-command.js'

type PluginContext = Plugin.Context
type PluginEvent = ReturnType<PluginContext['event']['subscribe']> extends AsyncIterable<infer E> ? E : never

export const COMPLETION_CHECK_COMMAND_NAME = 'completion-check-command'

const COMMAND_DESCRIPTION =
  'Register a shell command that will be executed after the agent finishes to verify task completion. Include a markdown code block with the shell command to run.'

const COMMAND_TEMPLATE = (argumentsText: string): string =>
  'The user wants to verify task completion after you finish. Run your task, and when you are done, a completion check will automatically run to verify your work.\n\nThe completion check command is:\n' +
  argumentsText

export interface CompletionCheckRuntime {
  ctx: PluginContext
  store: CompletionCheckStore
  processing: Set<string>
  resolved: Set<string>
}

function eventSessionID(event: PluginEvent): string | undefined {
  const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID
  return typeof sessionID === 'string' ? sessionID : undefined
}

function eventDirectory(event: PluginEvent): string | undefined {
  const location = (event as { location?: { directory?: unknown } }).location
  if (typeof location?.directory === 'string') return location.directory
  const dataLocation = (event as { data?: { location?: { directory?: unknown } } }).data?.location
  return typeof dataLocation?.directory === 'string' ? dataLocation.directory : undefined
}

export async function handleCompletionCheckEvent(
  { ctx, store, processing, resolved }: CompletionCheckRuntime,
  event: PluginEvent,
): Promise<void> {
  const eventSession = eventSessionID(event)
  if (eventSession && !resolved.has(eventSession)) {
    resolved.add(eventSession)
    if (!store.has(eventSession)) {
      const directory = eventDirectory(event) ?? ctx.location.directory
      const { command: defaultCommand } = await readDefaultCommand(directory)
      if (defaultCommand) {
        store.set(eventSession, defaultCommand, directory)
        console.log(`[Completion Check] Using default command from ${directory}.`)
      }
    }
  }

  const executionEnded =
    event.type === 'session.execution.succeeded' ||
    event.type === 'session.execution.failed' ||
    event.type === 'session.execution.interrupted'
  if (!executionEnded) return
  if (event.type === 'session.execution.interrupted' && event.data.reason !== 'user') return

  const sessionID = event.data.sessionID
  const command = store.get(sessionID)
  if (!command) return
  if (processing.has(sessionID)) return
  processing.add(sessionID)

  try {
    if (event.type === 'session.execution.failed' && isUsageLimitError(event.data.error)) {
      // The agent was cut off by the provider's usage limit rather than
      // finishing. Skip the completion check (and the re-prompt).
      console.warn('[Completion Check] Skipped: usage limit reached.')
      return
    }

    const directory = store.getDirectory(sessionID) || ctx.location.directory
    const result = await executeCommand(command, directory)

    if (result.exitCode === 0) {
      store.delete(sessionID)
      console.log(`[Completion Check] Command succeeded. Task is complete.\nCommand: ${command}`)
      return
    }

    if (store.retriesExhausted(sessionID)) {
      store.delete(sessionID)
      return
    }

    store.incrementRetries(sessionID)
    await ctx.session.prompt({ sessionID, text: buildFailureMessage(result) })
  } finally {
    processing.delete(sessionID)
  }
}

export async function CompletionCheckCommandSetup(ctx: PluginContext): Promise<() => void> {
  const maxRetries = typeof ctx.options?.maxRetries === 'number' ? ctx.options.maxRetries : DEFAULT_MAX_RETRIES
  const store = new CompletionCheckStore(maxRetries)
  const processing = new Set<string>()
  const resolved = new Set<string>()

  await ctx.command.transform((editor) => {
    editor.add({
      name: COMPLETION_CHECK_COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      execute: async ({ sessionID, prompt, delivery }) => {
        const command = parseCodeBlock(prompt.text)
        if (!command) {
          console.warn(
            "[Completion Check] I couldn't find a code block in your message. Include a markdown code block with the shell command to run.",
          )
          return
        }
        store.set(sessionID, command, store.getDirectory(sessionID))
        await ctx.session.prompt({ sessionID, text: COMMAND_TEMPLATE(prompt.text), delivery })
      },
    })
  })

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        void handleCompletionCheckEvent({ ctx, store, processing, resolved }, event).catch((error) => {
          console.error('[Completion Check] Failed to handle event', error)
        })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[Completion Check] Event subscription ended', error)
      }
    }
  })()

  return () => controller.abort()
}
