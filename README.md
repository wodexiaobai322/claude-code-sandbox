# Claude Code Sandbox

> [!WARNING]
>
> - This work is alpha and might have security issues, use at your own risk.
> - Check [TODO.md](./TODO.md) for the roadmap.
> - Email [dev@textcortex.com](mailto:dev@textcortex.com) for inquiries.

Run Claude Code as an autonomous agent inside Docker containers with automatic GitHub integration. Bypass all permissions safely.

<img width="1485" alt="Screenshot 2025-05-27 at 14 48 25" src="https://github.com/user-attachments/assets/c014b8f5-7f14-43fd-bf8e-bf41787f8ec8" />

## Why Claude Code Sandbox?

The primary goal of Claude Code Sandbox is to enable **full async agentic workflows** by allowing Claude Code to execute without permission prompts. By running Claude in an isolated Docker container with the `--dangerously-skip-permissions` flag, Claude can:

- Execute any command instantly without asking for permission
- Make code changes autonomously
- Run build tools, tests, and development servers
- Create commits and manage git operations
- Work continuously without interrupting the user

Access Claude through a **browser-based terminal** that lets you monitor and interact with the AI assistant while you work on other tasks. This creates a truly autonomous development assistant, similar to [OpenAI Codex](https://chatgpt.com/codex) or [Google Jules](https://jules.dev), but running locally on your machine with full control.

## Overview

Claude Code Sandbox allows you to run Claude Code in isolated Docker containers, providing a safe environment for AI-assisted development. It supports both **interactive** and **non-interactive** modes:

### Interactive Mode (Web UI & Terminal)
- Creates a new git branch for each session
- Monitors for commits made by Claude
- Provides interactive review of changes
- Web UI with browser-based terminal interface
- Direct terminal attach with `--no-web` option
- Real-time file synchronization and git integration

### Non-Interactive Mode (Exec Command)
- Execute Claude commands programmatically via `exec` command
- Stream output in real-time (text, JSON, or streaming JSON)
- Full Claude Code parameter support (models, permissions, tools)
- Perfect for automation, CI/CD, and API integration

### Core Features
- Handles credential forwarding securely (Claude API, GitHub, SSH)
- Enables push/PR creation workflows
- Runs custom setup commands for environment initialization
- Supports Docker and Podman containers
- Multiple container management with interactive selection

## Installation

Install Claude Code Sandbox globally from npm:

```bash
npm install -g @textcortex/claude-code-sandbox
```

### Prerequisites

- Node.js >= 18.0.0
- Docker or Podman
- Git (optional - for git integration features)
- Claude Code (`npm install -g @anthropic-ai/claude-code@latest`)

## Usage

### Quick Start

#### Interactive Mode (Recommended)

Simply run in any directory (git or non-git):

```bash
claude-sandbox
```

**In a git repository**, this will:
1. Create a new branch (`claude/[timestamp]`)
2. Start a Docker container with Claude Code
3. Launch a web UI at `http://localhost:3456`
4. Open your browser automatically
5. Monitor for commits and provide review options

**In a non-git directory**, this will:
1. Start a Docker container with Claude Code
2. Launch a web UI at `http://localhost:3456`
3. Open your browser automatically
4. Run without git integration (no commit monitoring)

#### Terminal-Only Mode

For direct terminal access without web UI:

```bash
claude-sandbox start --no-web
```

#### Non-Interactive Mode

For automation and scripting:

```bash
claude-sandbox exec "Write a Python function to calculate factorial"
```

### Commands

#### `claude-sandbox` (default)

Start a new container with web UI (recommended):

```bash
claude-sandbox
```

#### `claude-sandbox start`

Explicitly start a new container with options:

```bash
claude-sandbox start [options]

Options:
  -c, --config <path>       Configuration file (default: ./claude-sandbox.config.json)
  -n, --name <name>         Container name prefix
  --no-web                  Disable web UI (use terminal attach)
  --no-push                 Disable automatic branch pushing
  --no-create-pr            Disable automatic PR creation
  --no-git                  Disable git functionality (for non-git directories)
  --include-untracked       Include untracked files when copying to container
  -b, --branch <branch>     Switch to specific branch on container start
  --remote-branch <branch>  Checkout a remote branch (e.g., origin/feature-branch)
  --pr <number>             Checkout a specific PR by number
  --shell <shell>           Start with 'claude' or 'bash' shell
```

#### `claude-sandbox attach [container-id]`

Attach to an existing container:

```bash
# Interactive selection (web UI)
claude-sandbox attach

# Specific container (web UI)
claude-sandbox attach abc123def456

# Terminal-only mode
claude-sandbox attach --no-web
claude-sandbox attach abc123def456 --no-web --shell bash

Options:
  --no-web               Use terminal attach instead of web UI
  --shell <shell>        Shell to use when attaching (claude or bash, default: claude)
```

#### `claude-sandbox list`

List all Claude Sandbox containers:

```bash
claude-sandbox list
claude-sandbox ls        # alias

Options:
  -a, --all              Show all containers (including stopped)
```

#### `claude-sandbox stop [container-id]`

Stop containers:

```bash
# Interactive selection
claude-sandbox stop

# Specific container
claude-sandbox stop abc123def456

# Stop all
claude-sandbox stop --all
```

#### `claude-sandbox logs [container-id]`

View container logs:

```bash
claude-sandbox logs
claude-sandbox logs abc123def456

Options:
  -f, --follow           Follow log output
  -n, --tail <lines>     Number of lines to show (default: 50)
```

#### `claude-sandbox clean`

Remove stopped containers:

```bash
claude-sandbox clean
claude-sandbox clean --force  # Remove all containers
```

#### `claude-sandbox exec [prompt...]`

Execute a Claude command in container (non-interactive):

```bash
# Interactive container selection
claude-sandbox exec "帮我写一个Python函数计算阶乘"

# Specify container explicitly
claude-sandbox exec --container a5603c6539ca "解释这段代码的作用"

# Use streaming JSON output
claude-sandbox exec --output-format stream-json --verbose "写一个React组件"

# Specify model and other options
claude-sandbox exec --container a5603c6539ca --model sonnet "重构这个函数"

# Continue previous conversation
claude-sandbox exec --container a5603c6539ca --continue "还有其他建议吗？"
```

**Key Options:**
```
  --container <id>             Container ID to execute command in
  --output-format <format>     Output format: text, json, stream-json (default: text)
  --model <model>              Model to use (e.g., sonnet, opus)
  --permission-mode <mode>     Permission mode: acceptEdits, bypassPermissions, default, plan
  --allowedTools <tools...>    Allowed tools list
  --continue                   Continue the most recent conversation
  --resume [sessionId]         Resume a conversation
  --debug                      Enable debug mode
  --verbose                    Enable verbose mode
```

**Use Cases:**
- **Automation**: Integrate Claude into CI/CD pipelines and scripts
- **Batch Processing**: Process multiple prompts programmatically
- **API Integration**: Use as part of microservices and web applications
- **Development Tools**: Include in IDEs and development workflows

#### `claude-sandbox config`

Show current configuration:

```bash
claude-sandbox config
```

### Configuration

Create a `claude-sandbox.config.json` file (see `claude-sandbox.config.example.json` for reference):

```json
{
  "dockerImage": "claude-code-sandbox:latest",
  "dockerfile": "./custom.Dockerfile",
  "detached": false,
  "autoPush": true,
  "autoCreatePR": true,
  "autoStartClaude": true,
  "noGit": false,
  "envFile": ".env",
  "environment": {
    "NODE_ENV": "development"
  },
  "setupCommands": ["npm install", "npm run build"],
  "volumes": ["/host/path:/container/path:ro"],
  "mounts": [
    {
      "source": "./data",
      "target": "/workspace/data",
      "readonly": false
    },
    {
      "source": "/home/user/configs",
      "target": "/configs",
      "readonly": true
    }
  ],
  "allowedTools": ["*"],
  "maxThinkingTokens": 100000,
  "bashTimeout": 600000,
  "containerPrefix": "my-project",
  "claudeConfigPath": "~/.claude.json"
}
```

#### Configuration Options

- `dockerImage`: Base Docker image to use (default: `claude-code-sandbox:latest`)
- `dockerfile`: Path to custom Dockerfile (optional)
- `detached`: Run container in detached mode
- `autoPush`: Automatically push branches after commits (auto-disabled in non-git environments)
- `autoCreatePR`: Automatically create pull requests (auto-disabled in non-git environments)
- `autoStartClaude`: Start Claude Code automatically (default: true)
- `noGit`: Disable git functionality even in git repositories (default: false)
- `envFile`: Load environment variables from file (e.g., `.env`)
- `environment`: Additional environment variables
- `setupCommands`: Commands to run after container starts (e.g., install dependencies)
- `volumes`: Legacy volume mounts (string format)
- `mounts`: Modern mount configuration (object format)
- `allowedTools`: Claude tool permissions (default: all)
- `maxThinkingTokens`: Maximum thinking tokens for Claude
- `bashTimeout`: Timeout for bash commands in milliseconds
- `containerPrefix`: Custom prefix for container names
- `claudeConfigPath`: Path to Claude configuration file
- `dockerSocketPath`: Custom Docker/Podman socket path (auto-detected by default)

#### Mount Configuration

The `mounts` array allows you to mount files or directories into the container:

- `source`: Path on the host (relative paths are resolved from current directory)
- `target`: Path in the container (relative paths are resolved from /workspace)
- `readonly`: Optional boolean to make the mount read-only (default: false)

Example use cases:

- Mount data directories that shouldn't be in git
- Share configuration files between host and container
- Mount build artifacts or dependencies
- Access host system resources (use with caution)

## Features

### Non-Git Directory Support

Claude Code Sandbox now works seamlessly in both git and non-git environments:

**Intelligent Detection:**
- Automatically detects if the current directory is a git repository
- Gracefully handles non-git directories without errors
- No manual configuration required in most cases

**Automatic Feature Adjustment:**
- Git-related features (`autoPush`, `autoCreatePR`, commit monitoring) are automatically disabled in non-git environments
- Uses simple workspace names (e.g., "claude-session") instead of git-based branch names
- All other functionality remains fully available

**Manual Control:**
- Use `--no-git` flag to explicitly disable git functionality even in git repositories
- Set `"noGit": true` in configuration file for persistent non-git mode
- Useful for testing or when you want to avoid git operations

**Examples:**
```bash
# Works in any directory - auto-detects environment
claude-sandbox

# Explicitly disable git functionality
claude-sandbox --no-git
claude-sandbox start --no-git

# Configuration file approach
{
  "noGit": true,
  "autoPush": false,
  "autoCreatePR": false
}
```

### Podman Support

Claude Code Sandbox now supports Podman as an alternative to Docker. The tool automatically detects whether you're using Docker or Podman by checking for available socket paths:

- **Automatic detection**: The tool checks for Docker and Podman sockets in standard locations
- **Custom socket paths**: Use the `dockerSocketPath` configuration option to specify a custom socket
- **Environment variable**: Set `DOCKER_HOST` to override socket detection

Example configuration for Podman:

```json
{
  "dockerSocketPath": "/run/user/1000/podman/podman.sock"
}
```

The tool will automatically detect and use Podman if:

- Docker socket is not available
- Podman socket is found at standard locations (`/run/podman/podman.sock` or `$XDG_RUNTIME_DIR/podman/podman.sock`)

### Web UI Terminal

Launch a browser-based terminal interface to interact with Claude Code:

```bash
claude-sandbox --web
```

This will:

- Start the container in detached mode
- Launch a web server on `http://localhost:3456`
- Open your browser automatically
- Provide a full terminal interface with:
  - Real-time terminal streaming
  - Copy/paste support
  - Terminal resizing
  - Reconnection capabilities

Perfect for when you want to monitor Claude's work while doing other tasks.

### Automatic Credential Discovery

Claude Code Sandbox automatically discovers and forwards:

**Claude Credentials:**

- Anthropic API keys (`ANTHROPIC_API_KEY`)
- macOS Keychain credentials (Claude Code)
- AWS Bedrock credentials
- Google Vertex credentials
- Claude configuration files (`.claude.json`, `.claude/`)

**GitHub Credentials:**

- GitHub CLI authentication (`gh auth`)
- GitHub tokens (`GITHUB_TOKEN`, `GH_TOKEN`)
- Git configuration (`.gitconfig`)

### Sandboxed Execution

- Claude runs with `--dangerously-skip-permissions` flag (safe in container)
- Creates isolated branch for each session
- Full access to run any command within the container
- Files are copied into container (not mounted) for true isolation
- Git history preserved for proper version control

### Commit Monitoring

When Claude makes a commit:

1. Real-time notification appears
2. Full diff is displayed with syntax highlighting
3. Interactive menu offers options:
   - Continue working
   - Push branch to remote
   - Push branch and create PR
   - Exit

### Working with Multiple Containers

Run multiple Claude instances simultaneously:

```bash
# Terminal 1: Start main development
claude-sandbox start --name main-dev

# Terminal 2: Start feature branch work
claude-sandbox start --name feature-auth

# Terminal 3: List all running containers
claude-sandbox list

# Terminal 4: Attach to any container
claude-sandbox attach
```

## Docker Environment

### Default Image

The default Docker image includes:

- Ubuntu 22.04
- Git, GitHub CLI
- Node.js, npm
- Python 3
- Claude Code (latest)
- Build essentials

### Custom Dockerfile

Create a custom environment:

```dockerfile
FROM claude-code-sandbox:latest

# Add your tools
RUN apt-get update && apt-get install -y \
    rust \
    cargo \
    postgresql-client

# Install project dependencies
COPY package.json /tmp/
RUN cd /tmp && npm install

# Custom configuration
ENV CUSTOM_VAR=value
```

Reference in config:

```json
{
  "dockerfile": "./my-custom.Dockerfile"
}
```

## Workflow Example

1. **Start Claude Sandbox:**

   ```bash
   cd my-project
   claude-sandbox
   ```

2. **Interact with Claude:**

   ```
   > Help me refactor the authentication module to use JWT tokens
   ```

3. **Claude works autonomously:**

   - Explores codebase
   - Makes changes
   - Runs tests
   - Commits changes

4. **Review and push:**
   - See commit notification
   - Review syntax-highlighted diff
   - Choose to push and create PR

## Security Considerations

- Credentials are mounted read-only
- Containers are isolated from host
- Branch restrictions prevent accidental main branch modifications
- All changes require explicit user approval before pushing

## Troubleshooting

### Claude Code not found

Ensure Claude Code is installed globally:

```bash
npm install -g @anthropic-ai/claude-code@latest
```

### Docker permission issues

Add your user to the docker group:

```bash
sudo usermod -aG docker $USER
# Log out and back in for changes to take effect
```

### Container cleanup

Remove all Claude Sandbox containers and images:

```bash
npm run purge-containers
```

### Credential discovery fails

Set credentials explicitly:

```bash
export ANTHROPIC_API_KEY=your-key
export GITHUB_TOKEN=your-token
```

Or use an `.env` file with `envFile` config option.

### Build errors

Ensure you're using Node.js >= 18.0.0:

```bash
node --version
```

## Development

### Building from Source

To build and develop Claude Code Sandbox from source:

```bash
git clone https://github.com/textcortex/claude-code-sandbox.git
cd claude-code-sandbox
npm install
npm run build
npm link  # Creates global 'claude-sandbox' command
```

### Available Scripts

- `npm run build` - Build TypeScript to JavaScript
- `npm run dev` - Watch mode for development
- `npm start` - Run the CLI
- `npm run lint` - Run ESLint
- `npm test` - Run tests
- `npm run purge-containers` - Clean up all containers

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Run linter: `npm run lint`
6. Submit a pull request

## License

MIT
