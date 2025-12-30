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
  /** Unique request identifier for caching and tracking */
  id?: string;
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
 * Property definition for tool input schema
 */
export interface ToolInputProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolInputProperty | ToolInputSchema;
  properties?: Record<string, ToolInputProperty>;
  required?: string[];
}

/**
 * Tool input schema
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolInputProperty>;
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

// ============================================================================
// Message Types for Agent Tool Handling
// ============================================================================

/**
 * Tool use message content for assistant messages
 */
export interface ToolUseMessage {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result message content for user messages
 */
export interface ToolResultMessage {
  tool_use_id: string;
  type: "tool_result";
  content: string | undefined;
}

/**
 * Payload types for onSend hook
 */
export interface StreamPayloadWithUsage {
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: Error;
}

/**
 * Node.js error with code property
 */
export interface NodeError extends Error {
  code?: string;
}

/**
 * Done callback type for Fastify onSend hook
 */
export type OnSendDoneCallback = (
  err: Error | null,
  payload: unknown
) => void;

// ============================================================================
// Image Agent Types
// ============================================================================

/**
 * Image source structure for Anthropic API
 */
export interface ImageSource {
  type: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

/**
 * Image content block for messages
 */
export interface ImageContentBlock {
  type: "image";
  source: ImageSource;
}

/**
 * Image cache entry for storing processed images
 */
export interface ImageCacheEntry {
  source: ImageSource;
  timestamp: number;
}

/**
 * Message content item with image or tool_result
 */
export interface MessageContentItem {
  type: "text" | "image" | "tool_result" | "tool_use";
  text?: string;
  source?: ImageSource;
  content?: string | MessageContentItem[];
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Message structure with content array
 */
export interface MessageWithContent {
  role: "user" | "assistant";
  content: string | MessageContentItem[];
}

/**
 * Image analysis response from the API
 */
export interface ImageAnalysisResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: string;
}

// ============================================================================
// Code Command Types
// ============================================================================

/**
 * Status line settings for Claude Code
 */
export interface StatusLineSettings {
  type: "command";
  command: string;
  padding: number;
}

/**
 * Settings flag object for Claude Code execution
 */
export interface SettingsFlag {
  env: EnvironmentVariables;
  statusLine?: StatusLineSettings;
}

/**
 * Environment variables for Claude Code execution
 */
export interface EnvironmentVariables {
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL: string;
  NO_PROXY: string;
  DISABLE_TELEMETRY: string;
  DISABLE_COST_WARNINGS: string;
  API_TIMEOUT_MS: string;
  CLAUDE_CODE_USE_BEDROCK?: string;
  ANTHROPIC_SMALL_FAST_MODEL?: string;
  CI?: string;
  FORCE_COLOR?: string;
  NODE_NO_READLINE?: string;
  TERM?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// SSE Parser Types
// ============================================================================

/**
 * Parsed SSE event structure
 */
export interface ParsedSSEEvent {
  event?: string;
  data?: SSEEventData | { type: "done" } | { raw: string; error: string };
  id?: string;
  retry?: number;
}
