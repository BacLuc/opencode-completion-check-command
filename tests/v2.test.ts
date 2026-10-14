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
      context: vi.fn().mockResolvedValue([]),
    },
    location: { directory: process.cwd() },
    options: {},
  }
  return { ctx, commandDefinitions }
}

function runtime(ctx: any, store: CompletionCheckStore) {
  return { ctx, store, processing: new Set<string>() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CompletionCheckCommandSetup', () => {
  it('registers the completion-check-command and subscribes to events', async () => {
    const { ctx, commandDefinitions } = createMockCtx()

    const cleanup = await CompletionCheckCommandSetup(ctx as any)

    expect(commandDefinitions).toHaveLength(1)
    expect(commandDefinitions[0].name).toBe(COMPLETION_CHECK_COMMAND_NAME)
    expect(commandDefinitions[0].description).toBeTruthy()
    expect(typeof commandDefinitions[0].execute).toBe('function')

    expect(ctx.event.subscribe).toHaveBeenCalledTimes(1)
    const signal = ctx.event.subscribe.mock.calls[0][0].signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)

    cleanup()
    expect(signal.aborted).toBe(true)
  })

  it('stores the command and re-prompts with the template when executed with a code block', async () => {
    const { ctx, commandDefinitions } = createMockCtx()
    await CompletionCheckCommandSetup(ctx as any)

    await commandDefinitions[0].execute({
      sessionID: 's1',
      prompt: { text: codeBlock(FAIL_COMMAND) },
      delivery: 'steer',
    })

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
    const call = ctx.session.prompt.mock.calls[0][0]
    expect(call.sessionID).toBe('s1')
    expect(call.text).toContain(FAIL_COMMAND)
    expect(call.delivery).toBe('steer')
  })

  it('does not prompt when executed without a code block', async () => {
    const { ctx, commandDefinitions } = createMockCtx()
    await CompletionCheckCommandSetup(ctx as any)

    await commandDefinitions[0].execute({
      sessionID: 's1',
      prompt: { text: 'plain text' },
      delivery: 'steer',
    })

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })
})

describe('handleCompletionCheckEvent', () => {
  it('stores the default command from AGENTS.md on session.created', async () => {
    mockFsFiles([['/test/dir/AGENTS.md', '# AGENTS.md\n\n/completion-check-command\n' + codeBlock('npm test')]])
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/test/dir' } },
    } as any)

    expect(store.get('s1')).toBe('npm test')
    expect(store.getDirectory('s1')).toBe('/test/dir')
  })

  it('re-prompts on a failing command when the session goes idle via session.status', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'idle' } },
    } as any)

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
    expect(ctx.session.prompt.mock.calls[0][0].text).toContain('you are not yet finished')
  })

  it('does not prompt and removes the command when it succeeds', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', SUCCESS_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'idle' } },
    } as any)

    expect(ctx.session.prompt).not.toHaveBeenCalled()
    expect(store.get('s1')).toBeUndefined()
  })

  it('does not prompt on non-idle status', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'busy' } },
    } as any)

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('re-prompts on the deprecated session.idle event', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.idle',
      data: { sessionID: 's1' },
    } as any)

    expect(ctx.session.prompt).toHaveBeenCalledTimes(1)
    expect(ctx.session.prompt.mock.calls[0][0].text).toContain('you are not yet finished')
  })

  it('does not prompt when the session hit the usage limit', async () => {
    const { ctx } = createMockCtx()
    ctx.session.context.mockResolvedValue([
      { type: 'user' },
      { type: 'assistant', error: { type: 'provider', message: 'usage limit reached', status: 429 } },
    ])
    const store = new CompletionCheckStore()
    store.set('s1', FAIL_COMMAND, process.cwd())

    await handleCompletionCheckEvent(runtime(ctx, store), {
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'idle' } },
    } as any)

    expect(ctx.session.prompt).not.toHaveBeenCalled()
  })

  it('stops prompting once the retry budget is exhausted', async () => {
    const { ctx } = createMockCtx()
    const store = new CompletionCheckStore(2)
    store.set('s1', FAIL_COMMAND, process.cwd())

    for (let i = 0; i < 5; i++) {
      await handleCompletionCheckEvent(runtime(ctx, store), {
        type: 'session.status',
        data: { sessionID: 's1', status: { type: 'idle' } },
      } as any)
    }

    expect(ctx.session.prompt).toHaveBeenCalledTimes(2)
  })
})
