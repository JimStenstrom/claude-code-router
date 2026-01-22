import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { join } from "path";
import { initConfig, initDir, cleanupLogFiles } from "./utils";
import { createServer } from "./server";
import { router } from "./utils/router";
import { apiKeyAuth } from "./middleware/auth";
import {
  cleanupPidFile,
  isServiceRunning,
  savePid,
} from "./utils/processCheck";
import { CONFIG_FILE, HOME_DIR } from "./constants";
import { createStream, type Generator } from 'rotating-file-stream';
import { sessionUsageCache } from "./utils/cache";
import {
  processAgentStream,
  trackStreamUsage,
  shouldProcessRequest,
} from "./utils/onSendHandler";
import agentsManager from "./agents";
import { EventEmitter } from "node:events";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type {
  AppConfig,
  RouterRequest,
  StreamPayloadWithUsage,
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
      providers: config.Providers || (config as unknown as { providers?: typeof config.Providers }).providers,
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

    // Only process /v1/messages requests with a session ID
    if (!shouldProcessRequest(req, routerReq)) {
      return handleNonMessagePayload(payload, done);
    }

    // Handle streaming responses
    if (payload instanceof ReadableStream) {
      // Process agent tool calls if agents are active
      if (routerReq.agents) {
        const processedStream = processAgentStream(payload, routerReq, config as AppConfig);
        return done(null, processedStream);
      }

      // Track usage from stream in background
      const [originalStream, clonedStream] = payload.tee();
      trackStreamUsage(clonedStream, routerReq.sessionId!);
      return done(null, originalStream);
    }

    // Handle non-streaming responses
    const payloadWithUsage = payload as StreamPayloadWithUsage;
    sessionUsageCache.put(routerReq.sessionId!, payloadWithUsage.usage!);

    if (typeof payload === 'object' && payload !== null) {
      if (payloadWithUsage.error) {
        return done(payloadWithUsage.error, null);
      }
      return done(null, payload);
    }

    done(null, payload);
  });

  // Helper to handle non-message payloads with error checking
  function handleNonMessagePayload(payload: unknown, done: OnSendDoneCallback): void {
    const payloadWithError = payload as StreamPayloadWithUsage;
    if (typeof payload === 'object' && payload !== null && payloadWithError.error) {
      return done(payloadWithError.error, null);
    }
    done(null, payload);
  }

  // Event emission hook for external listeners
  server.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    event.emit('onSend', req, reply, payload);
    return payload;
  });


  server.start();
}

export { run };
// run();
