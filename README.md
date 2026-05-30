# opencode-completion-check-command

An [opencode](https://opencode.ai) plugin that automatically verifies task completion by running a shell command after the agent finishes.

## How It Works

1. Use the `/completion-check-command` slash command in your opencode prompt followed by a markdown code block containing the shell command to run
2. When the agent finishes (session goes idle), the plugin executes the stored command
3. If the command exits with code 0, the task is considered complete
4. If the command exits with a non-zero code, the agent is automatically prompted again with:

   ```
   you are not yet finished:

   stdout:
   <command stdout output>

   stderr:
   <command stderr output>
   ```

5. This retry loop continues up to a configurable maximum number of retries (default: 10). Once the limit is reached, the plugin stops re-prompting to prevent burning tokens indefinitely.

## Usage

In your opencode session, type:

````
/completion-check-command
```bash
./check-task.sh
```
````

The plugin will extract the command from the code block and run it when the agent finishes.

## Configuration

### Plugin Options

The plugin accepts an `maxRetries` option (default: `10`) that controls the maximum number of times the agent will be re-prompted when the check command fails:

```json
{
  "plugin": [["bacluc-opencode-completion-check-command@<version>", { "maxRetries": 10 }]]
}
```

Setting `maxRetries` to `0` disables re-prompting entirely — the command runs once and any failure is silently dropped.

### Custom Command Template

The `/completion-check-command` is automatically registered by the plugin's `config` hook. If you want to override the template, add it to your `opencode.json`:

```json
{
  "command": {
    "completion-check-command": {
      "template": "Your custom template here: {{arguments}}",
      "description": "Custom description"
    }
  }
}
```

## Example

Create a check script:

```bash
#!/bin/bash
# check-task.sh - verify the task is complete
if [ -f "output.txt" ]; then
  echo "Task complete - output file exists"
  exit 0
else
  echo "Task NOT complete - output file missing"
  echo "Create the file: output.txt"
  exit 1
fi
```

Then use it in opencode:

````
Please create a file called output.txt with the contents "Hello World"

/completion-check-command
```bash
./check-task.sh
```
````

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Format code
npm run format
```
