/**
 * Type definitions for Claude Code Router
 * Eliminates `any` types in favor of properly typed interfaces
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  MessageParam,
  Tool,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

// ============================================================================
// Provider & Router Configuration Types
// ============================================================================

/**
 * Transformer configuration for a provider
 */
export interface TransformerConfig {
  use?: Array<string | [string, Record<string, unknown>]>;
  [modelName: string]: Array<string | [string, Record<string, unknown>]> | undefined;
}

/**
 * LLM Provider configuration
 */
export interface Provider {
  name: string;
  api_base_url: string;
  api_key?: string;
  models: string[];
  transformer?: TransformerConfig;
}

/**
 * Router configuration for different request types
 */
export interface RouterConfig {
  default: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  webSearch?: string;
  image?: string;
}

/**
 * Status line module configuration
 */
export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string;
}

/**
 * Status line theme configuration
 */
export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

/**
 * Status line configuration
 */
export interface StatusLineConfig {
  currentStyle?: "default" | "powerline" | "simple";
  [styleName: string]: StatusLineThemeConfig | string | undefined;
}

/**
 * Main application configuration
 */
export interface AppConfig {
  HOST?: string;
  PORT?: number;
  APIKEY?: string;
  LOG?: boolean;
  LOG_LEVEL?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  API_TIMEOUT_MS?: number;
  PROXY_URL?: string;
  CLAUDE_PATH?: string;
  CUSTOM_ROUTER_PATH?: string;
  REWRITE_SYSTEM_PROMPT?: string;
  NON_INTERACTIVE_MODE?: boolean;
  Providers: Provider[];
  Router: RouterConfig;
  transformers?: CustomTransformerConfig[];
  StatusLine?: StatusLineConfig;
}

/**
 * Custom transformer plugin configuration
 */
export interface CustomTransformerConfig {
  path: string;
  options?: Record<string, unknown>;
}

// ============================================================================
// Message Content Types
// ============================================================================

/**
 * Text content block in a message
 */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * Tool use content block in a message
 */
export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content (can be string or array of content blocks)
 */
export type ToolResultContent = string | ContentBlockParam[];

/**
 * Tool result content block in a message
 */
export interface ToolResultContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

/**
 * Union type for all message content block types
 */
export type MessageContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | TextBlock
  | ToolUseBlock
  | ToolResultBlockParam;

// ============================================================================
// System Prompt Types
// ============================================================================

/**
 * Text block in system prompt array
 */
export interface SystemTextBlock {
  type: "text";
  text: string | string[];
}

/**
 * Cache control block in system prompt
 */
export interface SystemCacheControlBlock {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
  };
}

/**
 * System prompt can be a string or array of blocks
 */
export type SystemPrompt = string | SystemTextBlock[] | SystemCacheControlBlock[];

// ============================================================================
// Request Types
// ============================================================================

/**
 * Request body for messages API
 */
export interface MessagesRequestBody {
  model: string;
  messages: MessageParam[];
  system?: SystemPrompt;
  tools?: (Tool | WebSearchTool)[];
  thinking?: ThinkingConfig;
  metadata?: RequestMetadata;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

/**
 * Web search tool type
 */
export interface WebSearchTool {
  type: string;
  name: string;
}

/**
 * Thinking configuration for extended thinking
 */
export interface ThinkingConfig {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

/**
 * Request metadata
 */
export interface RequestMetadata {
  user_id?: string;
  [key: string]: unknown;
}

/**
 * Logger interface matching Fastify's logger methods we use
 */
export interface RouterLogger {
  info: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * Extended Fastify request with router-specific properties
 * Note: We use a separate interface rather than extending FastifyRequest
 * to avoid conflicts with FastifyBaseLogger's more complex type
 */
export interface RouterRequest {
  body: MessagesRequestBody;
  sessionId?: string;
  tokenCount?: number;
  agents?: string[];
  accessLevel?: "full" | "restricted";
  log: RouterLogger;
  url: string;
}

// ============================================================================
// Router Context Types
// ============================================================================

/**
 * Context passed to router middleware
 */
export interface RouterContext {
  config: AppConfig;
  event: NodeJS.EventEmitter;
}

/**
 * Custom router function signature
 */
export type CustomRouterFn = (
  req: RouterRequest,
  config: AppConfig,
  context: { event: NodeJS.EventEmitter }
) => Promise<string | undefined>;

// ============================================================================
// Server Configuration Types
// ============================================================================

/**
 * Logger configuration
 */
export interface LoggerConfig {
  level: string;
  stream: NodeJS.WritableStream;
}

/**
 * Server initialization configuration
 */
export interface ServerConfig {
  jsonPath: string;
  initialConfig: {
    providers: Provider[];
    HOST: string;
    PORT: number;
    LOG_FILE: string;
  };
  logger: LoggerConfig | false;
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * Token count response
 */
export interface TokenCountResponse {
  input_tokens: number;
}

/**
 * Config API response
 */
export interface ConfigResponse {
  success: boolean;
  message: string;
}

/**
 * Update check response
 */
export interface UpdateCheckResponse {
  hasUpdate: boolean;
  latestVersion?: string;
  changelog?: string;
}

/**
 * Log file metadata
 */
export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

/**
 * Query parameters for logs endpoint
 */
export interface LogsQueryParams {
  file?: string;
}

// ============================================================================
// Agent Types (extending existing types)
// ============================================================================

/**
 * Tool input schema
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
  }>;
  required?: string[];
}

/**
 * Tool handler context
 */
export interface ToolHandlerContext {
  req: RouterRequest;
  config: AppConfig;
}

// ============================================================================
// SSE Event Types
// ============================================================================

/**
 * SSE event data structure
 */
export interface SSEEvent {
  event: string;
  data: SSEEventData;
}

/**
 * SSE event data payload
 */
export interface SSEEventData {
  type?: string;
  index?: number;
  content_block?: {
    type: string;
    name?: string;
    id?: string;
    text?: string;
  };
  delta?: {
    type: string;
    partial_json?: string;
    text?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}
