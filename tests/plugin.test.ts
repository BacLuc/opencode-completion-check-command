import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import {
  CompletionCheckCommandPlugin,
  CompletionCheckStore,
  DEFAULT_MAX_RETRIES,
  executeCommand,
  parseCodeBlock,
  readDefaultCommandFromAgentsMd,
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

describe('readDefaultCommandFromAgentsMd', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should return null if AGENTS.md does not exist', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'))
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBeNull()
    expect(fs.readFile).toHaveBeenCalledWith('/test/dir/AGENTS.md', 'utf-8')
  })

  it('should return null if AGENTS.md has no /completion-check-command', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('# Some instructions\n\nDo something.')
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBeNull()
  })

  it('should extract command from AGENTS.md with /completion-check-command', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(
      '# Instructions\n\nRun this after completion:\n/completion-check-command\n```bash\nnpm test\n```',
    )
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBe('npm test')
  })

  it('should return null if /completion-check-command exists but no code block', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('Some text\n/completion-check-command\nMore text')
    const result = await readDefaultCommandFromAgentsMd('/test/dir')
    expect(result).toBeNull()
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

// A few real shell commands used by the integration-style plugin tests below.
// They run through the real `/bin/sh`, exactly like the plugin does in
// production, so no shell mocking is needed.
const SUCCESS_COMMAND = 'true'
const FAIL_COMMAND = 'echo some error output; echo some stderr 1>&2; exit 1'

function codeBlock(command: string): string {
  return '```bash\n' + command + '\n```'
}

function createMockInput(options?: Record<string, unknown>) {
  return {
    client: {
      session: {
        promptAsync: vi.fn().mockResolvedValue({ data: {} }),
      },
      tui: {
        showToast: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
    project: {
      id: 'test-project',
      worktree: '/test',
      vcsDir: '/test',
      time: { created: Date.now() },
    },
    // A real, existing working directory so the spawned shell can chdir into it.
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL('http://localhost:12345'),
    experimental_workspace: { register: vi.fn() },
    ...(options || {}),
  }
}

describe('executeCommand (real execution)', () => {
  it('should run a command available in /sbin via the real PATH', async () => {
    // `sysctl` lives in /sbin (resp. /usr/sbin) and is available in every
    // terminal. This proves the command is resolved against the real PATH the
    // way a normal shell does, which is exactly what broke for `docker` before.
    const result = await executeCommand('sysctl -n kernel.ostype', process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('Linux')
    expect(result.stderr).toBe('')
  })

  it('should run a multi-word command and capture stdout', async () => {
    const result = await executeCommand('echo hello world', process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello world')
  })

  it('should capture a non-zero exit code together with stdout and stderr', async () => {
    const result = await executeCommand('echo out; echo err 1>&2; exit 3', process.cwd())
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('out')
    expect(result.stderr).toContain('err')
  })

  it('should report a non-zero exit code for an unknown command', async () => {
    const result = await executeCommand('this-command-definitely-does-not-exist-xyz', process.cwd())
    expect(result.exitCode).not.toBe(0)
  })
})

describe('CompletionCheckCommandPlugin', () => {
  describe('hook registration', () => {
    it('should return hooks with command.execute.before, config, and event handlers', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      expect(hooks['command.execute.before']).toBeDefined()
      expect(hooks['event']).toBeDefined()
      expect(hooks['config']).toBeDefined()
    })
  })

  describe('config hook', () => {
    it('should register the completion-check-command in config', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)
      const config: any = {}
      await hooks.config!(config)
      expect(config.command).toBeDefined()
      expect(config.command['completion-check-command']).toBeDefined()
      expect(config.command['completion-check-command'].template).toContain('{{arguments}}')
      expect(config.command['completion-check-command'].description).toBeDefined()
    })

    it('should not overwrite existing command config', async () => {
      const mockInput = createMockInput()
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
    it('should record and run the command when /completion-check-command is invoked with a code block', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-123',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      })

      // The recorded (failing) command ran, so the agent was re-prompted.
      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
    })

    it('should not record command for other commands', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'other-command',
          sessionID: 'session-123',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-123' },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })

    it('should send warning feedback when no code block is found in arguments', async () => {
      const mockInput = createMockInput()
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

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain("couldn't find")
      expect(callArgs.body.variant).toBe('warning')
    })

    it('should send confirmation feedback when command is registered', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-123',
          arguments: codeBlock('./check.sh'),
        },
        { parts },
      )

      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain('Registered!')
      expect(callArgs.body.message).toContain('./check.sh')
      expect(callArgs.body.variant).toBe('success')
    })
  })

  describe('event handling', () => {
    it('should ignore non-idle events', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-abc',
          arguments: codeBlock(FAIL_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.status',
          properties: { sessionID: 'session-abc', status: { type: 'busy' } },
        },
      })

      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()
    })
  })

  describe('command execution on idle', () => {
    it('should not prompt again when command succeeds', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-ok',
          arguments: codeBlock(SUCCESS_COMMAND),
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
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should prompt the agent again with stdout and stderr when command fails', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-fail',
          arguments: codeBlock(FAIL_COMMAND),
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
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const failureCall = mockInput.client.session.promptAsync.mock.calls[0][0]
      expect(failureCall.path.id).toBe('session-fail')
      expect(failureCall.body.parts[0].text).toContain('you are not yet finished:')
      expect(failureCall.body.parts[0].text).toContain('some error output')
      expect(failureCall.body.parts[0].text).toContain('some stderr')
    })

    it('should use default command from AGENTS.md when no session command is set', async () => {
      const mockInput = createMockInput()

      vi.spyOn(fs, 'readFile').mockResolvedValue('# AGENTS.md\n\n/completion-check-command\n' + codeBlock(FAIL_COMMAND))

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-default',
              directory: process.cwd(),
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-default' },
        },
      })

      // The failing default command from AGENTS.md ran and re-prompted the agent.
      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(fs.readFile).toHaveBeenCalledWith(process.cwd() + '/AGENTS.md', 'utf-8')

      vi.restoreAllMocks()
    })

    it('should notify user when default command is found in AGENTS.md', async () => {
      const mockInput = createMockInput()

      vi.spyOn(fs, 'readFile').mockResolvedValue(
        '# AGENTS.md\n\n/completion-check-command\n```bash\n./default-check.sh\n```',
      )

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-notify',
              directory: '/test/dir',
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
      const callArgs = mockInput.client.tui.showToast.mock.calls[0][0]
      expect(callArgs.body.title).toBe('Completion Check')
      expect(callArgs.body.message).toContain('Found default completion check command in AGENTS.md')
      expect(callArgs.body.message).toContain('./default-check.sh')
      expect(callArgs.body.variant).toBe('info')
      expect(fs.readFile).toHaveBeenCalledWith('/test/dir/AGENTS.md', 'utf-8')

      vi.restoreAllMocks()
    })

    it('should prefer session-specific command over AGENTS.md default', async () => {
      const mockInput = createMockInput()

      // AGENTS.md default would fail (and re-prompt) ...
      vi.spyOn(fs, 'readFile').mockResolvedValue('# AGENTS.md\n\n/completion-check-command\n' + codeBlock(FAIL_COMMAND))

      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      await hooks['event']!({
        event: {
          type: 'session.created',
          properties: {
            info: {
              id: 'session-override',
              directory: process.cwd(),
              projectID: 'test-project',
              title: 'Test Session',
              version: '1',
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        },
      })

      // ... but the session-specific command succeeds, overriding the default.
      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-override',
          arguments: codeBlock(SUCCESS_COMMAND),
        },
        { parts },
      )

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-override' },
        },
      })

      // Session-specific (succeeding) command was used, so no re-prompt.
      expect(mockInput.client.session.promptAsync).not.toHaveBeenCalled()

      vi.restoreAllMocks()
    })
  })

  describe('max retries', () => {
    it('should use the default max retries when no option is provided', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any)

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-retry',
          arguments: codeBlock(FAIL_COMMAND),
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
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should stop prompting after max retries are exhausted', async () => {
      const customMaxRetries = 2
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: customMaxRetries,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-retry2',
          arguments: codeBlock(FAIL_COMMAND),
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
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should allow setting maxRetries to 0 to disable re-prompting entirely', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: 0,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-no-retry',
          arguments: codeBlock(FAIL_COMMAND),
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
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })

    it('should respect maxRetries=1 by allowing exactly one re-prompt', async () => {
      const mockInput = createMockInput()
      const hooks = await CompletionCheckCommandPlugin(mockInput as any, {
        maxRetries: 1,
      })

      const parts: any[] = []
      await hooks['command.execute.before']!(
        {
          command: 'completion-check-command',
          sessionID: 'session-one-retry',
          arguments: codeBlock(FAIL_COMMAND),
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
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)

      await hooks['event']!({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'session-one-retry' },
        },
      })

      expect(mockInput.client.session.promptAsync).toHaveBeenCalledTimes(1)
      expect(mockInput.client.tui.showToast).toHaveBeenCalledTimes(1)
    })
  })
})
