import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CompletionCheckCommandPlugin,
  CompletionCheckStore,
  DEFAULT_MAX_RETRIES,
  parseCodeBlock,
} from '../src/completion-check-command.js'

describe('parseCodeBlock', () => {
  it.each([
    ['bash code block', '```bash\necho "hello"\n```', 'echo "hello"'],
    ['code block without language tag', '```\necho hello\n```', 'echo hello'],
    ['shell language tag', '```shell\n./check.sh\n```', './check.sh'],
    ['sh language tag', '```sh\n./run.sh --flag\n```', './run.sh --flag'],
    ['tilde-delimited code block', '~~~bash\necho hello\n~~~', 'echo hello'],
    ['multi-line command', '```bash\n./check.sh &&\necho done\n```', './check.sh &&\necho done'],
    [
      'code block with surrounding text',
      'Here is the check:\n```bash\n./check.sh\n```\nRun this please.',
      './check.sh',
    ],
    ['trimmed whitespace', '```bash\n  ./check.sh  \n```', './check.sh'],
    ['command with pipes', "```bash\ncat output.txt | grep -c 'PASS'\n```", "cat output.txt | grep -c 'PASS'"],
    ['plain text with no code block', 'just some plain text', null],
    ['empty string', '', null],
  ])('should parse %s', (_name, input, expected) => {
    expect(parseCodeBlock(input)).toBe(expected)
  })
})

describe('CompletionCheckStore', () => {
  let store: CompletionCheckStore

  beforeEach(() => {
    store = new CompletionCheckStore()
  })

  it('should store and retrieve commands', () => {
    store.set('session-1', './check.sh')
    expect(store.get('session-1')).toBe('./check.sh')
  })

  it('should return undefined for unknown session', () => {
    expect(store.get('unknown')).toBeUndefined()
  })

  it('should delete a stored command', () => {
    store.set('session-1', './check.sh')
    store.delete('session-1')
    expect(store.get('session-1')).toBeUndefined()
  })

  it('should report has() correctly', () => {
    expect(store.has('session-1')).toBe(false)
    store.set('session-1', './check.sh')
    expect(store.has('session-1')).toBe(true)
    store.delete('session-1')
    expect(store.has('session-1')).toBe(false)
  })

  it('should clear all commands', () => {
    store.set('session-1', './check1.sh')
    store.set('session-2', './check2.sh')
    store.clear()
    expect(store.has('session-1')).toBe(false)
    expect(store.has('session-2')).toBe(false)
  })

  it('should overwrite existing command for same session', () => {
    store.set('session-1', './old-check.sh')
    store.set('session-1', './new-check.sh')
    expect(store.get('session-1')).toBe('./new-check.sh')
  })

  it('should track retries starting at 0', () => {
    store.set('session-1', './check.sh')
    expect(store.getEntry('session-1')?.retries).toBe(0)
  })

  it('should increment retries', () => {
    store.set('session-1', './check.sh')
    expect(store.incrementRetries('session-1')).toBe(1)
    expect(store.incrementRetries('session-1')).toBe(2)
    expect(store.getEntry('session-1')?.retries).toBe(2)
  })

  it('should return -1 when incrementing retries for unknown session', () => {
    expect(store.incrementRetries('unknown')).toBe(-1)
  })

  it('should default maxRetries to DEFAULT_MAX_RETRIES', () => {
    expect(store.getMaxRetries()).toBe(DEFAULT_MAX_RETRIES)
  })

  it('should accept custom maxRetries', () => {
    const customStore = new CompletionCheckStore(5)
    expect(customStore.getMaxRetries()).toBe(5)
  })

  describe('retriesExhausted', () => {
    it('should not be exhausted at 0 retries', () => {
      store.set('session-1', './check.sh')
      expect(store.retriesExhausted('session-1')).toBe(false)
    })

    it('should be exhausted when retries reach maxRetries', () => {
      store.set('session-1', './check.sh')
      for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
        store.incrementRetries('session-1')
      }
      expect(store.retriesExhausted('session-1')).toBe(true)
    })

    it('should not be exhausted just below maxRetries', () => {
      store.set('session-1', './check.sh')
      for (let i = 0; i < DEFAULT_MAX_RETRIES - 1; i++) {
        store.incrementRetries('session-1')
      }
      expect(store.retriesExhausted('session-1')).toBe(false)
    })

    it('should return false for unknown session', () => {
      expect(store.retriesExhausted('unknown')).toBe(false)
    })

    it('should respect custom maxRetries', () => {
      const customStore = new CompletionCheckStore(1)
      customStore.set('session-1', './check.sh')
      expect(customStore.retriesExhausted('session-1')).toBe(false)
      customStore.incrementRetries('session-1')
      expect(customStore.retriesExhausted('session-1')).toBe(true)
    })
  })
})

function createMockShell(exitCode: number, stdout: string, stderr: string) {
  const result = {
    exitCode,
    text: () => stdout,
    stderr: { toString: () => stderr },
  }
  return vi.fn().mockReturnValue({
    nothrow: () => ({
      quiet: () => ({
        cwd: () => Promise.resolve(result),
      }),
    }),
  })
}

function createMockInput(shellFn: ReturnType<typeof createMockShell>, options?: Record<string, unknown>) {
  return {
    client: {
      session: {
        promptAsync: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
    project: {
      id: 'test-project',
      worktree: '/test',
      vcsDir: '/test',
      time: { created: Date.now() },
    },
    directory: '/test/dir',
    worktree: '/test',
    $: shellFn,
    serverUrl: new URL('http://localhost:12345'),
    experimental_workspace: { register: vi.fn() },
    ...(options || {}),
  }
}

describe('CompletionCheckCommandPlugin', () => {
  describe('hook registration', () => {
    it('should return hooks with command.execute.before, config, and event handlers', async () => {
      const mockShell = createMockShell(0, '', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      expect(hooks['command.execute.before']).toBeDefined()
      expect(hooks['event']).toBeDefined()
      expect(hooks['config']).toBeDefined()
    })
  })

  describe('config hook', () => {
    it('should register the completion-check-command in config', async () => {
      const mockShell = createMockShell(0, '', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      const config: any = {}
      await hooks.config!(config)
      expect(config.command).toBeDefined()
      expect(config.command['completion-check-command']).toBeDefined()
      expect(config.command['completion-check-command'].template).toContain('{{arguments}}')
      expect(config.command['completion-check-command'].description).toBeDefined()
    })

    it('should not overwrite existing command config', async () => {
      const mockShell = createMockShell(0, '', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      const customTemplate = 'Custom template {{arguments}}'
      const config: any = {
        command: {
          'completion-check-command': {
            template: customTemplate,
            description: 'My custom description',
          },
        },
      }
      await hooks.config!(config)
      expect(config.command['completion-check-command'].template).toBe(customTemplate)
    })
  })

  describe('command recording', () => {
    it('should record command when /completion-check-command is invoked with a code block', async () => {
      const mockShell = createMockShell(0, '', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-123',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      })

      expect(mockShell).toHaveBeenCalled()
    })

    it('should not record command for other commands', async () => {
      const mockShell = vi.fn()
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'other-command',
          sessionID: 'session-123',
          arguments: '```bash\necho hi\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      })

      expect(mockShell).not.toHaveBeenCalled()
    })

    it('should not record command if no code block in arguments', async () => {
      const mockShell = vi.fn()
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-nocode',
          arguments: 'just plain text',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-nocode' },
        },
      })

      expect(mockShell).not.toHaveBeenCalled()
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })
  })

  describe('event handling', () => {
    it('should ignore non-idle events', async () => {
      const mockShell = vi.fn()
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-abc',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.status',
          properties: { sessionID: 'session-abc', status: { type: 'busy' } },
        },
      })

      expect(mockShell).not.toHaveBeenCalled()
    })
  })

  describe('command execution on idle', () => {
    it('should not prompt again when command succeeds', async () => {
      const mockShell = createMockShell(0, 'all good', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-ok',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-ok' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })

    it('should prompt the agent again when command fails', async () => {
      const mockShell = createMockShell(1, 'some error output', 'some stderr')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-fail',
          arguments: '```bash\n./failing-check.sh\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-fail' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.session.promptAsync.mock.calls[0][0]
      expect(callArgs.path.id).toBe('session-fail')
      expect(callArgs.body.parts[0].text).toContain('you are not yet finished:')
      expect(callArgs.body.parts[0].text).toContain('some error output')
      expect(callArgs.body.parts[0].text).toContain('some stderr')
    })
  })

  describe('max retries', () => {
    it('should use the default max retries (3) when no option is provided', async () => {
      const mockShell = createMockShell(1, 'error', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-retry',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
        await hooks['event']!({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'session-retry' },
          },
        })
      }

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES)
    })

    it('should stop prompting after max retries are exhausted', async () => {
      const mockShell = createMockShell(1, 'error', '')
      const customMaxRetries = 2
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: customMaxRetries,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-retry2',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      for (let i = 0; i < customMaxRetries + 1; i++) {
        await hooks['event']!({
          event: {
            type: 'session.idle',
            properties: { sessionID: 'session-retry2' },
          },
        })
      }

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(customMaxRetries)
    })

    it('should allow setting maxRetries to 0 to disable re-prompting entirely', async () => {
      const mockShell = createMockShell(1, 'error', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: 0,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-no-retry',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-no-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })

    it('should respect maxRetries=1 by allowing exactly one re-prompt', async () => {
      const mockShell = createMockShell(1, 'error', '')
      const mockInput = createMockInput(mockShell)
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: 1,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-one-retry',
          arguments: '```bash\n./check.sh\n```',
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-one-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-one-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
    })
  })
})
