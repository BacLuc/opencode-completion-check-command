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
}

export async function sessionHitUsageLimitV2(ctx: PluginContext, sessionID: string): Promise<boolean> {
  try {
    const messages = await ctx.session.context({ sessionID })
    if (!Array.isArray(messages)) return false
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]
      if (info.type === 'assistant') {
        return isUsageLimitError(info.error)
      }
    }
    return false
  } catch {
    return false
  }
}

export async function handleCompletionCheckEvent(
  { ctx, store, processing }: CompletionCheckRuntime,
  event: PluginEvent,
): Promise<void> {
  if (event.type === 'session.created') {
    const { sessionID, location } = event.data
    const { command: defaultCommand } = await readDefaultCommand(location.directory)
    if (defaultCommand) {
      store.set(sessionID, defaultCommand, location.directory)
      console.log(`[Completion Check] Using default command from ${location.directory}.`)
    }
    return
  }

  const isIdle = event.type === 'session.idle' || (event.type === 'session.status' && event.data.status.type === 'idle')
  if (!isIdle) return

  const sessionID = event.data.sessionID
  const command = store.get(sessionID)
  if (!command) return
  if (processing.has(sessionID)) return
  processing.add(sessionID)

  try {
    if (await sessionHitUsageLimitV2(ctx, sessionID)) {
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
        try {
          await handleCompletionCheckEvent({ ctx, store, processing }, event)
        } catch (error) {
          console.error('[Completion Check] Failed to handle event', error)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[Completion Check] Event subscription ended', error)
      }
    }
  })()

  return () => controller.abort()
}
