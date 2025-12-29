import type { ToolInputSchema, ToolHandlerContext, RouterRequest, AppConfig } from "../types";

/**
 * Tool definition interface for agent tools
 */
export interface ITool {
  /** Unique name for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema for the tool's input parameters */
  input_schema: ToolInputSchema;
  /**
   * Handler function that executes the tool
   * @param args - Parsed arguments matching the input_schema
   * @param context - Context containing request and config
   * @returns Promise resolving to the tool's string output
   */
  handler: (args: Record<string, unknown>, context: ToolHandlerContext) => Promise<string>;
}

/**
 * Agent interface defining the contract for request handling agents
 */
export interface IAgent {
  /** Unique name for the agent */
  name: string;
  /** Map of tool names to tool definitions */
  tools: Map<string, ITool>;
  /**
   * Determines if this agent should handle the given request
   * @param req - The incoming request
   * @param config - Application configuration
   * @returns true if this agent should handle the request
   */
  shouldHandle: (req: RouterRequest, config: AppConfig) => boolean;
  /**
   * Modifies the request before it's sent to the LLM
   * @param req - The incoming request (will be mutated)
   * @param config - Application configuration
   */
  reqHandler: (req: RouterRequest, config: AppConfig) => void;
  /**
   * Optional handler for processing the response payload
   * @param payload - The response payload from the LLM
   * @param config - Application configuration
   */
  resHandler?: (payload: unknown, config: AppConfig) => void;
}
