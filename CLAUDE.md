# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

-   **Build the project**:
    ```bash
    npm run build
    ```
-   **Run tests**:
    ```bash
    npm test
    ```
-   **Run tests with coverage**:
    ```bash
    npm test -- --coverage
    ```
-   **Start the router server**:
    ```bash
    ccr start
    ```
-   **Stop the router server**:
    ```bash
    ccr stop
    ```
-   **Check the server status**:
    ```bash
    ccr status
    ```
-   **Run Claude Code through the router**:
    ```bash
    ccr code "<your prompt>"
    ```
-   **Release a new version**:
    ```bash
    npm run release
    ```

## Architecture

This project is a TypeScript-based router for Claude Code requests. It allows routing requests to different large language models (LLMs) from various providers based on custom rules.

### Core Components

| File | Description |
|------|-------------|
| `src/cli.ts` | Main CLI entry point. Handles commands: `start`, `stop`, `status`, `code` |
| `src/index.ts` | Server initialization and Fastify hook setup |
| `src/server.ts` | Fastify server creation and route configuration |
| `src/constants.ts` | Application constants (paths, timeouts, defaults) |
| `src/types.ts` | TypeScript type definitions |

### Utilities (`src/utils/`)

| File | Description |
|------|-------------|
| `router.ts` | Core routing logic - determines which provider/model to use |
| `onSendHandler.ts` | SSE stream processing and agent tool execution helpers |
| `processCheck.ts` | Process management (PID files, service detection) |
| `SSEParser.transform.ts` | Server-Sent Events stream parser |
| `SSESerializer.transform.ts` | SSE stream serializer |
| `rewriteStream.ts` | Stream transformation utilities |
| `cache.ts` | LRU cache for session/usage tracking |
| `statusline.ts` | Terminal status line formatting |
| `modelSelector.ts` | Interactive model selection UI |
| `auth.ts` | API key authentication middleware |

### Agents (`src/agents/`)

| File | Description |
|------|-------------|
| `index.ts` | Agent manager - registers and retrieves agents |
| `image.agent.ts` | Image processing agent with tool definitions |
| `type.ts` | Agent interface definitions |

### Key Concepts

-   **Routing**: Supports multiple route types: `default`, `background`, `think`, `longContext`, `webSearch`. Custom routing via JavaScript file.
-   **Providers**: Multiple LLM provider support with request/response transformers.
-   **Agents**: Extensible agent system that can intercept requests and provide custom tools.
-   **Configuration**: `~/.claude-code-router/config.json` defines providers, routes, and settings.

## Test Coverage

Current test coverage is low (~8%). Only `router.ts` has good coverage (~78%).

**Files needing tests:**
- `onSendHandler.ts` - Stream processing logic
- `auth.ts` - Authentication (security-critical)
- `processCheck.ts` - Process management
- `SSEParser.transform.ts` - Stream parsing

Run `npm test -- --coverage` to see detailed coverage report.

## Development Notes

-   Built with `esbuild` for fast compilation
-   Uses `@musistudio/llms` which is based on Fastify
-   Server exposes Fastify's hook interface via `server.addHook`
-   SSE streams are used for real-time response streaming
-   Do not commit automatically without explicit user request
