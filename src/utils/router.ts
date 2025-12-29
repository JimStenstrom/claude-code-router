import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile, access } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "../constants";
import { LRUCache } from "lru-cache";
import type {
  AppConfig,
  RouterConfig,
  Provider,
  RouterRequest,
  RouterContext,
  SystemPrompt,
  SystemTextBlock,
  MessageContentBlock,
  WebSearchTool,
} from "../types";

const enc = get_encoding("cl100k_base");

/**
 * Calculate the total token count for a request
 * Uses tiktoken with cl100k_base encoding to count tokens in messages, system prompts, and tools
 *
 * @param messages - Array of message parameters from the request
 * @param system - System prompt, can be a string or array of text blocks
 * @param tools - Array of tool definitions
 * @returns Total token count for the request
 */
export const calculateTokenCount = (
  messages: MessageParam[],
  system: SystemPrompt | undefined,
  tools: Tool[]
): number => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart) => {
          if (contentPart.type === "text" && "text" in contentPart) {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use" && "input" in contentPart) {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result" && "content" in contentPart) {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item) => {
      if (item.type !== "text") return;
      const textItem = item as SystemTextBlock;
      if (typeof textItem.text === "string") {
        tokenCount += enc.encode(textItem.text).length;
      } else if (Array.isArray(textItem.text)) {
        textItem.text.forEach((textPart: string) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

/**
 * Read and parse a JSON configuration file
 * @param filePath - Path to the configuration file
 * @returns Parsed configuration object, or null if file doesn't exist or parsing fails
 */
const readConfigFile = async (filePath: string): Promise<Partial<AppConfig> | null> => {
  try {
    await access(filePath);
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as Partial<AppConfig>;
  } catch (error) {
    return null; // Return null if file doesn't exist or read fails
  }
};

/**
 * Get project-specific router configuration based on session ID
 * Checks for session-specific config first, then project-level config
 *
 * @param req - Request object containing sessionId
 * @returns Project-specific router config, or undefined to use global config
 */
const getProjectSpecificRouter = async (req: RouterRequest): Promise<RouterConfig | undefined> => {
  // Check if there is a project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read the session-specific config file
      const sessionConfig = await readConfigFile(sessionConfigPath);
      if (sessionConfig && sessionConfig.Router) {
        return sessionConfig.Router;
      }
      const projectConfig = await readConfigFile(projectConfigPath);
      if (projectConfig && projectConfig.Router) {
        return projectConfig.Router;
      }
    }
  }
  return undefined; // Return undefined to use the original configuration
};

/**
 * Determine which model to use for a request based on routing rules
 *
 * Priority order:
 * 1. Explicit provider,model format in request
 * 2. Long context model (if token count exceeds threshold)
 * 3. Subagent model (if specified in system prompt)
 * 4. Background model (for Claude Haiku requests)
 * 5. Web search model (if web_search tools present)
 * 6. Think model (if thinking is enabled)
 * 7. Default model
 *
 * @param req - Request object with body containing model and tools
 * @param tokenCount - Calculated token count for the request
 * @param config - Application configuration
 * @param lastUsage - Previous session's token usage for context-aware routing
 * @returns Model identifier in "provider,model" format
 */
const getUseModel = async (
  req: RouterRequest,
  tokenCount: number,
  config: AppConfig,
  lastUsage?: Usage | undefined
): Promise<string> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req);
  const Router = projectSpecificRouter || config.Router;

  if (req.body.model.includes(",")) {
    const [provider, model] = req.body.model.split(",");
    const finalProvider = config.Providers.find(
      (p: Provider) => p.name.toLowerCase() === provider
    );
    const finalModel = finalProvider?.models?.find(
      (m: string) => m.toLowerCase() === model
    );
    if (finalProvider && finalModel) {
      return `${finalProvider.name},${finalModel}`;
    }
    return req.body.model;
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = Router.longContextThreshold || 60000;
  const lastUsageThreshold =
    lastUsage &&
    lastUsage.input_tokens > longContextThreshold &&
    tokenCount > 20000;
  const tokenCountThreshold = tokenCount > longContextThreshold;
  if ((lastUsageThreshold || tokenCountThreshold) && Router.longContext) {
    req.log.info(
      `Using long context model due to token count: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    return Router.longContext;
  }

  // Check for CCR-SUBAGENT-MODEL in system prompt
  const systemPrompt = req.body.system;
  if (
    Array.isArray(systemPrompt) &&
    systemPrompt.length > 1 &&
    systemPrompt[1]?.type === "text"
  ) {
    const systemBlock = systemPrompt[1] as SystemTextBlock;
    if (typeof systemBlock.text === "string" && systemBlock.text.startsWith("<CCR-SUBAGENT-MODEL>")) {
      const modelMatch = systemBlock.text.match(
        /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
      );
      if (modelMatch) {
        systemBlock.text = systemBlock.text.replace(
          `<CCR-SUBAGENT-MODEL>${modelMatch[1]}</CCR-SUBAGENT-MODEL>`,
          ""
        );
        return modelMatch[1];
      }
    }
  }

  // Use the background model for any Claude Haiku variant
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    config.Router.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    return config.Router.background;
  }

  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool) => {
      const webSearchTool = tool as WebSearchTool;
      return webSearchTool.type?.startsWith("web_search");
    }) &&
    Router.webSearch
  ) {
    return Router.webSearch;
  }

  // If thinking is enabled, use the think model
  if (req.body.thinking && Router.think) {
    req.log.info(`Using think model for ${JSON.stringify(req.body.thinking)}`);
    return Router.think;
  }
  return Router.default;
};

/**
 * Main router middleware for handling LLM request routing
 *
 * This function:
 * - Extracts session ID from request metadata
 * - Calculates token count for the request
 * - Applies custom router if configured
 * - Determines the appropriate model based on routing rules
 * - Modifies req.body.model with the selected model
 *
 * @param req - Fastify request object
 * @param _res - Fastify reply object (unused)
 * @param context - Context containing config and event emitter
 */
export const router = async (
  req: RouterRequest,
  _res: unknown,
  context: RouterContext
): Promise<void> => {
  const { config, event } = context;
  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }
  const lastMessageUsage = req.sessionId ? sessionUsageCache.get(req.sessionId) : undefined;
  const { messages, system = [], tools } = req.body;

  // Rewrite system prompt if configured
  if (
    config.REWRITE_SYSTEM_PROMPT &&
    Array.isArray(system) &&
    system.length > 1
  ) {
    const systemBlock = system[1] as SystemTextBlock;
    if (typeof systemBlock?.text === "string" && systemBlock.text.includes("<env>")) {
      const prompt = await readFile(config.REWRITE_SYSTEM_PROMPT, "utf-8");
      systemBlock.text = `${prompt}<env>${systemBlock.text.split("<env>").pop()}`;
    }
  }

  try {
    const tokenCount = calculateTokenCount(
      messages as MessageParam[],
      system as SystemPrompt,
      tools as Tool[]
    );

    let model: string | undefined;
    if (config.CUSTOM_ROUTER_PATH) {
      try {
        const customRouter = require(config.CUSTOM_ROUTER_PATH);
        req.tokenCount = tokenCount; // Pass token count to custom router
        model = await customRouter(req, config, {
          event,
        });
      } catch (e: unknown) {
        const error = e as Error;
        req.log.error(`failed to load custom router: ${error.message}`);
      }
    }
    if (!model) {
      model = await getUseModel(req, tokenCount, config, lastMessageUsage);
    }
    req.body.model = model;
  } catch (error: unknown) {
    const err = error as Error;
    req.log.error(`Error in router middleware: ${err.message}`);
    req.body.model = config.Router.default;
  }
  return;
};

// In-memory cache storing sessionId to project name mapping
// An empty string value indicates a previous lookup that found no project
// Uses LRU cache with a maximum of 1000 entries
const sessionProjectCache = new LRUCache<string, string>({
  max: 1000,
});

// Sentinel value to indicate "not found" in cache
const NOT_FOUND_SENTINEL = "";

/**
 * Search for a project by session ID
 *
 * Looks through ~/.claude/projects/ directories to find which project
 * contains the session file (sessionId.jsonl). Results are cached using
 * an LRU cache with max 1000 entries.
 *
 * @param sessionId - The session identifier to search for
 * @returns Project folder name if found, null otherwise
 */
export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // First check the cache
  if (sessionProjectCache.has(sessionId)) {
    const cached = sessionProjectCache.get(sessionId);
    // Empty string is our sentinel for "not found"
    return cached === NOT_FOUND_SENTINEL ? null : cached ?? null;
  }

  try {
    const dir = await opendir(CLAUDE_PROJECTS_DIR);
    const folderNames: string[] = [];

    // Collect all folder names
    for await (const dirent of dir) {
      if (dirent.isDirectory()) {
        folderNames.push(dirent.name);
      }
    }

    // Concurrently check if sessionId.jsonl file exists in each project folder
    const checkPromises = folderNames.map(async (folderName) => {
      const sessionFilePath = join(
        CLAUDE_PROJECTS_DIR,
        folderName,
        `${sessionId}.jsonl`
      );
      try {
        const fileStat = await stat(sessionFilePath);
        return fileStat.isFile() ? folderName : null;
      } catch {
        // File doesn't exist, continue checking the next one
        return null;
      }
    });

    const results = await Promise.all(checkPromises);

    // Return the first existing project directory name
    for (const result of results) {
      if (result) {
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        return result;
      }
    }

    // Cache the not-found result (empty string indicates a previous lookup found no project)
    sessionProjectCache.set(sessionId, NOT_FOUND_SENTINEL);
    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    // Also cache sentinel result on error to avoid repeated failures
    sessionProjectCache.set(sessionId, NOT_FOUND_SENTINEL);
    return null;
  }
};
