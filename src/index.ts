import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { randomBytes } from "crypto";
import path, { join } from "path";
import { initConfig, initDir, cleanupLogFiles } from "./utils";
import { createServer } from "./server";
import { router } from "./utils/router";
import { apiKeyAuth } from "./middleware/auth";
import {
  cleanupPidFile,
  isServiceRunning,
  savePid,
} from "./utils/processCheck";
import { CONFIG_FILE } from "./constants";
import { createStream, type Generator } from 'rotating-file-stream';
import { HOME_DIR } from "./constants";
import { sessionUsageCache } from "./utils/cache";
import { SSEParserTransform } from "./utils/SSEParser.transform";
import { SSESerializerTransform } from "./utils/SSESerializer.transform";
import { rewriteStream } from "./utils/rewriteStream";
import JSON5 from "json5";
import { IAgent } from "./agents/type";
import agentsManager from "./agents";
import { EventEmitter } from "node:events";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type {
  AppConfig,
  RouterRequest,
  SSEEvent,
  ToolUseMessage,
  ToolResultMessage,
  StreamPayloadWithUsage,
  NodeError,
  OnSendDoneCallback,
} from "./types";

const event = new EventEmitter();

async function initializeClaudeConfig() {
  const homeDir = homedir();
  const configPath = join(homeDir, ".claude.json");
  if (!existsSync(configPath)) {
    // Use cryptographically secure random bytes for user ID
    const userID = randomBytes(32).toString('hex');
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: "enabled",
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "1.0.17",
      projects: {},
    };
    await writeFile(configPath, JSON.stringify(configContent, null, 2));
  }
}

interface RunOptions {
  port?: number;
}

async function run(options: RunOptions = {}) {
  // Check if service is already running
  const isRunning = await isServiceRunning()
  if (isRunning) {
    console.log("✅ Service is already running in the background.");
    return;
  }

  await initializeClaudeConfig();
  await initDir();
  // Clean up old log files, keeping only the 10 most recent ones
  await cleanupLogFiles();
  const config = await initConfig();


  let HOST = config.HOST || "127.0.0.1";

  if (config.HOST && !config.APIKEY) {
    HOST = "127.0.0.1";
    console.warn("⚠️ API key is not set. HOST is forced to 127.0.0.1.");
  }

  const port = config.PORT || 3456;

  // Save the PID of the background process
  savePid(process.pid);

  // Handle SIGINT (Ctrl+C) to clean up PID file
  process.on("SIGINT", () => {
    console.log("Received SIGINT, cleaning up...");
    cleanupPidFile();
    process.exit(0);
  });

  // Handle SIGTERM to clean up PID file
  process.on("SIGTERM", () => {
    cleanupPidFile();
    process.exit(0);
  });

  // Use port from environment variable if set (for background process)
  const servicePort = process.env.SERVICE_PORT
    ? parseInt(process.env.SERVICE_PORT)
    : port;

  // Configure logger based on config settings
  const pad = (num: number): string => (num > 9 ? "" : "0") + num;
  // Generator function for rotating file stream log names
  const generator: Generator = (time: Date | number, index?: number): string => {
    const date = typeof time === 'number' ? new Date(time) : (time || new Date());

    const month = date.getFullYear() + "" + pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());

    return `./logs/ccr-${month}${day}${hour}${minute}${pad(date.getSeconds())}${index ? `_${index}` : ''}.log`;
  };
  const loggerConfig =
    config.LOG !== false
      ? {
          level: config.LOG_LEVEL || "debug",
          stream: createStream(generator, {
            path: HOME_DIR,
            maxFiles: 3,
            interval: "1d",
            compress: false,
            maxSize: "50M"
          }),
        }
      : false;

  const server = createServer({
    jsonPath: CONFIG_FILE,
    initialConfig: {
      // ...config,
      providers: config.Providers || config.providers,
      HOST: HOST,
      PORT: servicePort,
      LOG_FILE: join(
        homedir(),
        ".claude-code-router",
        "claude-code-router.log"
      ),
    },
    logger: loggerConfig,
  });

  // Add global error handlers to prevent the service from crashing
  process.on("uncaughtException", (err) => {
    server.logger.error("Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason, promise) => {
    server.logger.error("Unhandled rejection at:", promise, "reason:", reason);
  });
  // Add async preHandler hook for authentication
  server.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      // Call the async auth function
      apiKeyAuth(config)(req, reply, done).catch(reject);
    });
  });

  // Router preHandler hook - handles agent detection and request routing
  server.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith("/v1/messages") && !req.url.startsWith("/v1/messages/count_tokens")) {
      const routerReq = req as unknown as RouterRequest;
      const useAgents: string[] = [];

      for (const agent of agentsManager.getAllAgents()) {
        if (agent.shouldHandle(routerReq, config as AppConfig)) {
          // Set agent identifier
          useAgents.push(agent.name);

          // Change request body
          agent.reqHandler(routerReq, config as AppConfig);

          // Append agent tools
          if (agent.tools.size) {
            if (!routerReq.body?.tools?.length) {
              routerReq.body.tools = [];
            }
            const agentTools = Array.from(agent.tools.values()).map(item => ({
              name: item.name,
              description: item.description,
              input_schema: item.input_schema
            })) as Tool[];
            routerReq.body.tools.unshift(...agentTools);
          }
        }
      }

      if (useAgents.length) {
        routerReq.agents = useAgents;
      }
      await router(routerReq, reply, {
        config: config as AppConfig,
        event
      });
    }
  });

  // Error hook - emits error events
  server.addHook("onError", async (request: FastifyRequest, reply: FastifyReply, error: Error) => {
    event.emit('onError', request, reply, error);
  });
  // Response processing hook - handles agent tool execution and usage tracking
  server.addHook("onSend", (
    req: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: OnSendDoneCallback
  ) => {
    const routerReq = req as unknown as RouterRequest;
    if (routerReq.sessionId && req.url.startsWith("/v1/messages") && !req.url.startsWith("/v1/messages/count_tokens")) {
      if (payload instanceof ReadableStream) {
        if (routerReq.agents) {
          const abortController = new AbortController();
          const eventStream = payload.pipeThrough(new SSEParserTransform());
          let currentAgent: undefined | IAgent;
          let currentToolIndex = -1;
          let currentToolName = '';
          let currentToolArgs = '';
          let currentToolId = '';
          const toolMessages: ToolResultMessage[] = [];
          const assistantMessages: ToolUseMessage[] = [];

          // Process SSE stream and handle agent tool calls
          return done(null, rewriteStream(eventStream, async (data: SSEEvent, controller: ReadableStreamDefaultController) => {
            try {
              // Detect tool call start
              if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
                const agent = routerReq.agents!.find((name: string) => agentsManager.getAgent(name)?.tools.get(data.data.content_block!.name!));
                if (agent) {
                  currentAgent = agentsManager.getAgent(agent);
                  currentToolIndex = data.data.index!;
                  currentToolName = data.data.content_block.name;
                  currentToolId = data.data.content_block.id!;
                  return undefined;
                }
              }

              // Collect tool arguments
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.delta?.type === 'input_json_delta') {
                currentToolArgs += data.data?.delta?.partial_json || '';
                return undefined;
              }

              // Tool call completed - process agent invocation
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data.type === 'content_block_stop') {
                try {
                  const args = JSON5.parse(currentToolArgs) as Record<string, unknown>;
                  assistantMessages.push({
                    type: "tool_use",
                    id: currentToolId,
                    name: currentToolName,
                    input: args
                  });
                  const toolResult = await currentAgent?.tools.get(currentToolName)?.handler(args, {
                    req: routerReq,
                    config: config as AppConfig
                  });
                  toolMessages.push({
                    tool_use_id: currentToolId,
                    type: "tool_result",
                    content: toolResult
                  });
                  currentAgent = undefined;
                  currentToolIndex = -1;
                  currentToolName = '';
                  currentToolArgs = '';
                  currentToolId = '';
                } catch (e) {
                  console.log(e);
                }
                return undefined;
              }

              if (data.event === 'message_delta' && toolMessages.length) {
                routerReq.body.messages.push({
                  role: 'assistant',
                  content: assistantMessages
                });
                routerReq.body.messages.push({
                  role: 'user',
                  content: toolMessages
                });
                const response = await fetch(`http://127.0.0.1:${config.PORT || 3456}/v1/messages`, {
                  method: "POST",
                  headers: {
                    'x-api-key': config.APIKEY || '',
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(routerReq.body),
                });
                if (!response.ok) {
                  return undefined;
                }
                const stream = response.body!.pipeThrough(new SSEParserTransform());
                const reader = stream.getReader();
                while (true) {
                  try {
                    const { value, done: streamDone } = await reader.read();
                    if (streamDone) {
                      break;
                    }
                    if (value.event && ['message_start', 'message_stop'].includes(value.event)) {
                      continue;
                    }

                    // Check if stream is still writable
                    if (!controller.desiredSize) {
                      break;
                    }

                    controller.enqueue(value);
                  } catch (readError: unknown) {
                    const nodeError = readError as NodeError;
                    if (nodeError.name === 'AbortError' || nodeError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                      abortController.abort(); // Abort all related operations
                      break;
                    }
                    throw readError;
                  }
                }
                return undefined;
              }
              return data;
            } catch (error: unknown) {
              console.error('Unexpected error in stream processing:', error);

              // Handle stream premature close error
              const nodeError = error as NodeError;
              if (nodeError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                abortController.abort();
                return undefined;
              }

              // Re-throw other errors
              throw error;
            }
          }).pipeThrough(new SSESerializerTransform()));
        }

        const [originalStream, clonedStream] = payload.tee();
        const read = async (stream: ReadableStream): Promise<void> => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done: streamDone, value } = await reader.read();
              if (streamDone) break;
              // Process the value if needed
              const dataStr = new TextDecoder().decode(value);
              if (!dataStr.startsWith("event: message_delta")) {
                continue;
              }
              const str = dataStr.slice(27);
              try {
                const message = JSON.parse(str);
                sessionUsageCache.put(routerReq.sessionId!, message.usage);
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
        read(clonedStream);
        return done(null, originalStream);
      }
      const payloadWithUsage = payload as StreamPayloadWithUsage;
      sessionUsageCache.put(routerReq.sessionId!, payloadWithUsage.usage!);
      if (typeof payload === 'object' && payload !== null) {
        if (payloadWithUsage.error) {
          return done(payloadWithUsage.error, null);
        } else {
          return done(null, payload);
        }
      }
    }
    const payloadWithError = payload as StreamPayloadWithUsage;
    if (typeof payload === 'object' && payload !== null && payloadWithError.error) {
      return done(payloadWithError.error, null);
    }
    done(null, payload);
  });

  // Event emission hook for external listeners
  server.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    event.emit('onSend', req, reply, payload);
    return payload;
  });


  server.start();
}

export { run };
// run();
