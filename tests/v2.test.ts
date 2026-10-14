import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { CompletionCheckStore } from '../src/completion-check-command.js'
import { COMPLETION_CHECK_COMMAND_NAME, CompletionCheckCommandSetup, handleCompletionCheckEvent } from '../src/v2.js'

const SUCCESS_COMMAND = 'true'
const FAIL_COMMAND = 'echo some error output; echo some stderr 1>&2; exit 1'

function codeBlock(command: string): string {
  return '```bash\n' + command + '\n```'
}

function mockFsFiles(entries: Array<[string, string | Error]>) {
  const files = new Map<string, string | Error>(entries)
  return vi.spyOn(fs, 'readFile').mockImplementation(async (path) => {
    const key = String(path)
    const value = files.get(key)
    if (value instanceof Error) {
      throw value
    }
    if (value !== undefined) {
      return value
    }
    throw new Error(`ENOENT: ${key}`)
  })
}

function createMockCtx() {
  const commandDefinitions: any[] = []
  const ctx = {
    command: {
      transform: vi.fn(async (callback: (editor: { add: (definition: any) => void }) => void) => {
        callback({ add: (definition) => commandDefinitions.push(definition) })
      }),
    },
    event: {
      subscribe: vi.fn((_options: { signal: AbortSignal }) => (async function* () {})()),
    },
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
    },
    location: { directory: process.cwd() },
    options: {},
  }
  return { ctx, commandDefinitions }
}

function executionEnded(type: 'succeeded' | 'failed' | 'interrupted', extra: Record<string, unknown> = {}) {
  return { type: `session.execution.${type}`, data: { sessionID: 's1', ...extra } }
}

function runtime(ctx: any, store: CompletionCheckStore) {
  return { ctx, store, processing: new Set<string>(), resolved: new Set<string>() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CompletionCheckCommandSetup', () => {
  it('registers the completion-check-command and subscribes to events', async () => {
    const { ctx, commandDefinitions } = createMockCtx()
    await CompletionCheckCommandSetup(ctx as any)

    expect(commandDefinitions).toHaveLength(1)
    expect(commandDefinitions[0].name).toBe(COMPLETION_CHECK_COMMAND_NAME)

    const subscription = ctx.event.subscribe.mock.calls[0][0] as { signal: AbortSignal }
    expect(subscription.signal).toBeInstanceOf(AbortSignal)
  })

  it('re-prompts with the completion check template when the command is invoked', async () => {
    const { ctx, commandDefinitions } = createMockCtx()
    await CompletionCheckCommandSetup(ctx as any)

    await commandDefinitions[0].execute({
      sessionID: 's1',
      prompt: { text: codeBlock(FAIL_COMMAND) },
      delivery: 'steer',
    })

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
    expect(ctx.session.prompt.mock.calls[0][0].text).toContain(FAIL_COMMAND)
  })

  it('ignores invocations without a code block', async () => {
    const { ctx, commandDefinitions } = createMockCtx()
    await CompletionCheckCommandSetup(ctx as any)

    await commandDefinitions[0].execute({ sessionID: 's1', prompt: { text: 'no code here' }, delivery: 'steer' })

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })
})

describe('handleCompletionCheckEvent', () => {
  it('registers the default command from AGENTS.md on session.created', async () => {
    mockFsFiles([['/repo/AGENTS.md', '# Repo\n\n/completion-check-command\n' + codeBlock(FAIL_COMMAND)]])
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/repo' } },
    } as any)

    expect(store.get('s1')).toBe(FAIL_COMMAND)
  })

  it('resolves the default command from the first session event and runs the check', async () => {
    mockFsFiles([[`${process.cwd()}/AGENTS.md`, '# Repo\n\n/completion-check-command\n' + codeBlock(FAIL_COMMAND)]])
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.execution.succeeded',
      location: { directory: process.cwd() },
      data: { sessionID: 's1' },
    } as any)

    expect(store.get('s1')).toBe(FAIL_COMMAND)
    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
  })

  it('does not re-register the default command after a successful check', async () => {
    const readFile = mockFsFiles([
      [`${process.cwd()}/AGENTS.md`, '# Repo\n\n/completion-check-command\n' + codeBlock(SUCCESS_COMMAND)],
    ])
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    const sharedRuntime = runtime(ctx, store)
    const event = {
      type: 'session.execution.succeeded',
      location: { directory: process.cwd() },
      data: { sessionID: 's1' },
    }

    await handleCompletionCheckEvent(sharedRuntime, event as any)
    await handleCompletionCheckEvent(sharedRuntime, event as any)

    expect(readFile.mock.calls.filter(([path]) => String(path) === `${process.cwd()}/AGENTS.md`)).toHaveLength(1)
    expect(store.get('s1')).toBeUndefined()
    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('runs the check and re-prompts when the execution succeeded but the command failed', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), executionEnded('succeeded') as any)

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
    expect(ctx.session.prompt.mock.calls[0][0].text).toContain('you are not yet finished')
  })

  it('removes the command without prompting when it succeeds', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', SUCCESS_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), executionEnded('succeeded') as any)

    expect(ctx.session.prompt).not.toHaveBeenCalled()
    expect(store.get('s1')).toBeUndefined()
  })

  it('runs the check when the execution failed with a non-usage-limit error', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(
      runtime(ctx, store),
      executionEnded('failed', { error: { type: 'provider', message: 'boom', status: 500 } }) as any,
    )

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
  })

  it('skips the check when the execution failed with a usage limit error', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(
      runtime(ctx, store),
      executionEnded('failed', { error: { type: 'provider', message: 'usage limit reached', status: 429 } }) as any,
    )

    expect(ctx.session.prompt).not.toHaveBeenCalled()
    expect(store.get('s1')).toBe(FAIL_COMMAND)
  })

  it('runs the check when the execution was interrupted by the user', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), executionEnded('interrupted', { reason: 'user' }) as any)

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
  })

  it('skips the check when the execution was interrupted by a shutdown', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), executionEnded('interrupted', { reason: 'shutdown' }) as any)

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('skips the check when the execution was interrupted because it was superseded', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(
      runtime(ctx, store),
      executionEnded('interrupted', { reason: 'superseded' }) as any,
    )

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('skips the check when the execution was interrupted by inactivity', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(
      runtime(ctx, store),
      executionEnded('interrupted', { reason: 'inactivity' }) as any,
    )

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('does not run before the execution ends', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.execution.started',
      data: { sessionID: 's1' },
    } as any)

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('stops prompting once the retry budget is exhausted', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore(2)
    store.set('s1', FAIL_COMMAND, process.cwd())
    const sharedRuntime = runtime(ctx, store)

    for (let i = 0; i < 5; i++) {
      await handleCompletionCheckEvent(sharedRuntime, executionEnded('succeeded') as any)
    }

    expect(ctx.session.prompt).toHaveBeenCalledTimes(2)
  })
})
