/**
 * Helper functions for the onSend hook
 * Extracted from src/index.ts to improve maintainability and testability
 */

import JSON5 from "json5";
import { SSEParserTransform } from "./SSEParser.transform";
import { SSESerializerTransform } from "./SSESerializer.transform";
import { rewriteStream } from "./rewriteStream";
import { sessionUsageCache } from "./cache";
import agentsManager from "../agents";
import { INTERNAL_FETCH_TIMEOUT_MS, DEFAULT_PORT } from "../constants";
import type { IAgent } from "../agents/type";
import type {
  AppConfig,
  RouterRequest,
  SSEEvent,
  ToolUseMessage,
  ToolResultMessage,
  NodeError,
} from "../types";

/**
 * State management for agent tool execution during stream processing
 */
export interface AgentToolState {
  currentAgent: IAgent | undefined;
  currentToolIndex: number;
  currentToolName: string;
  currentToolArgs: string;
  currentToolId: string;
  toolMessages: ToolResultMessage[];
  assistantMessages: ToolUseMessage[];
}

/**
 * Creates initial state for agent tool processing
 */
export function createAgentToolState(): AgentToolState {
  return {
    currentAgent: undefined,
    currentToolIndex: -1,
    currentToolName: '',
    currentToolArgs: '',
    currentToolId: '',
    toolMessages: [],
    assistantMessages: [],
  };
}

/**
 * Resets tool state after processing completes or errors
 */
export function resetToolState(state: AgentToolState): void {
  state.currentAgent = undefined;
  state.currentToolIndex = -1;
  state.currentToolName = '';
  state.currentToolArgs = '';
  state.currentToolId = '';
}

/**
 * Detects if an SSE event starts a tool call and updates state
 * @returns true if a tool call was detected
 */
export function detectToolCallStart(
  data: SSEEvent,
  state: AgentToolState,
  agents: string[]
): boolean {
  if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
    const agent = agents.find((name: string) =>
      agentsManager.getAgent(name)?.tools.get(data.data.content_block!.name!)
    );
    if (agent) {
      state.currentAgent = agentsManager.getAgent(agent);
      state.currentToolIndex = data.data.index!;
      state.currentToolName = data.data.content_block.name;
      state.currentToolId = data.data.content_block.id!;
      return true;
    }
  }
  return false;
}

/**
 * Collects tool arguments from input_json_delta events
 * @returns true if arguments were collected
 */
export function collectToolArguments(data: SSEEvent, state: AgentToolState): boolean {
  if (
    state.currentToolIndex > -1 &&
    data.data.index === state.currentToolIndex &&
    data.data?.delta?.type === 'input_json_delta'
  ) {
    state.currentToolArgs += data.data?.delta?.partial_json || '';
    return true;
  }
  return false;
}

/**
 * Executes agent tool when content_block_stop is received
 * @returns true if tool was executed
 */
export async function executeAgentTool(
  data: SSEEvent,
  state: AgentToolState,
  routerReq: RouterRequest,
  config: AppConfig
): Promise<boolean> {
  if (
    state.currentToolIndex > -1 &&
    data.data.index === state.currentToolIndex &&
    data.data.type === 'content_block_stop'
  ) {
    try {
      const args = JSON5.parse(state.currentToolArgs) as Record<string, unknown>;
      state.assistantMessages.push({
        type: "tool_use",
        id: state.currentToolId,
        name: state.currentToolName,
        input: args
      });
      const toolResult = await state.currentAgent?.tools.get(state.currentToolName)?.handler(args, {
        req: routerReq,
        config
      });
      state.toolMessages.push({
        tool_use_id: state.currentToolId,
        type: "tool_result",
        content: toolResult
      });
    } catch (e) {
      console.error('Error executing agent tool:', state.currentToolName, e);
    }
    resetToolState(state);
    return true;
  }
  return false;
}

/**
 * Makes internal fetch to continue conversation after tool execution
 */
export async function fetchToolResponse(
  routerReq: RouterRequest,
  state: AgentToolState,
  config: AppConfig,
  controller: ReadableStreamDefaultController,
  abortController: AbortController
): Promise<void> {
  // Add tool messages to request body
  routerReq.body.messages.push({
    role: 'assistant',
    content: state.assistantMessages
  });
  routerReq.body.messages.push({
    role: 'user',
    content: state.toolMessages
  });

  const fetchController = new AbortController();
  const timeoutId = setTimeout(() => fetchController.abort(), INTERNAL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${config.PORT || DEFAULT_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        'x-api-key': config.APIKEY || '',
        'content-type': 'application/json',
      },
      body: JSON.stringify(routerReq.body),
      signal: fetchController.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error('Internal fetch failed with status:', response.status);
      return;
    }

    await pipeResponseToController(response, controller, abortController);
  } catch (fetchError: unknown) {
    clearTimeout(timeoutId);
    const nodeError = fetchError as NodeError;
    if (nodeError.name === 'AbortError') {
      console.error('Internal fetch timed out after', INTERNAL_FETCH_TIMEOUT_MS, 'ms');
    } else {
      console.error('Internal fetch error:', fetchError);
    }
  }
}

/**
 * Pipes response stream to controller, filtering message_start/stop events
 */
async function pipeResponseToController(
  response: Response,
  controller: ReadableStreamDefaultController,
  abortController: AbortController
): Promise<void> {
  const stream = response.body!.pipeThrough(new SSEParserTransform());
  const reader = stream.getReader();

  while (true) {
    try {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;

      if (value.event && ['message_start', 'message_stop'].includes(value.event)) {
        continue;
      }

      if (!controller.desiredSize) break;

      controller.enqueue(value);
    } catch (readError: unknown) {
      const nodeError = readError as NodeError;
      if (nodeError.name === 'AbortError' || nodeError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        abortController.abort();
        break;
      }
      throw readError;
    }
  }
}

/**
 * Creates the SSE event processor callback for agent tool handling
 */
export function createAgentStreamProcessor(
  routerReq: RouterRequest,
  config: AppConfig,
  abortController: AbortController
): (data: SSEEvent, controller: ReadableStreamDefaultController) => Promise<SSEEvent | undefined> {
  const state = createAgentToolState();

  return async (data: SSEEvent, controller: ReadableStreamDefaultController) => {
    try {
      // Detect tool call start
      if (detectToolCallStart(data, state, routerReq.agents!)) {
        return undefined;
      }

      // Collect tool arguments
      if (collectToolArguments(data, state)) {
        return undefined;
      }

      // Tool call completed - execute
      if (await executeAgentTool(data, state, routerReq, config)) {
        return undefined;
      }

      // Handle message_delta with pending tool messages
      if (data.event === 'message_delta' && state.toolMessages.length) {
        await fetchToolResponse(routerReq, state, config, controller, abortController);
        return undefined;
      }

      return data;
    } catch (error: unknown) {
      console.error('Unexpected error in stream processing:', error);

      const nodeError = error as NodeError;
      if (nodeError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        abortController.abort();
        return undefined;
      }

      throw error;
    }
  };
}

/**
 * Processes a stream with agent tool handling
 */
export function processAgentStream(
  payload: ReadableStream,
  routerReq: RouterRequest,
  config: AppConfig
): ReadableStream {
  const abortController = new AbortController();
  const eventStream = payload.pipeThrough(new SSEParserTransform());
  const processor = createAgentStreamProcessor(routerReq, config, abortController);

  return rewriteStream(eventStream, processor).pipeThrough(new SSESerializerTransform());
}

/**
 * Tracks usage from a cloned stream in the background
 */
export function trackStreamUsage(stream: ReadableStream, sessionId: string): void {
  const read = async (): Promise<void> => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        const dataStr = new TextDecoder().decode(value);
        if (!dataStr.startsWith("event: message_delta")) {
          continue;
        }

        const str = dataStr.slice(27);
        try {
          const message = JSON.parse(str);
          sessionUsageCache.put(sessionId, message.usage);
        } catch {
          // Ignore parse errors
        }
      }
    } catch (readError: unknown) {
      const nodeError = readError as NodeError;
      if (nodeError.name === 'AbortError' || nodeError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Background read stream closed prematurely');
      } else {
        console.error('Error in background stream reading:', readError);
      }
    } finally {
      reader.releaseLock();
    }
  };

  read();
}

/**
 * Checks if the request should be processed by onSend handler
 */
export function shouldProcessRequest(req: { url: string }, routerReq: RouterRequest): boolean {
  return !!(
    routerReq.sessionId &&
    req.url.startsWith("/v1/messages") &&
    !req.url.startsWith("/v1/messages/count_tokens")
  );
}
