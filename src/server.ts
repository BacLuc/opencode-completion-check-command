import type { PluginModule } from '@opencode-ai/plugin'
import { CompletionCheckCommandPlugin } from './completion-check-command.js'

const plugin: PluginModule = {
  id: 'opencode-completion-check-command',
  server: CompletionCheckCommandPlugin,
}

export default plugin
