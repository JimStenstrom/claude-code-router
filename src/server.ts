import Server from "@musistudio/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { checkForUpdates, performUpdate } from "./utils";
import { join, resolve, normalize } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";

/**
 * Validate that a file path is within the allowed logs directory
 * Prevents path traversal attacks
 */
function isPathWithinLogsDir(filePath: string, logDir: string): boolean {
  const normalizedPath = normalize(resolve(filePath));
  const normalizedLogDir = normalize(resolve(logDir));
  return normalizedPath.startsWith(normalizedLogDir + "/") || normalizedPath === normalizedLogDir;
}
import { calculateTokenCount } from "./utils/router";
import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  ServerConfig,
  LogFileInfo,
  LogsQueryParams,
  MessagesRequestBody,
  AppConfig,
} from "./types";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";

/**
 * Request body for count_tokens endpoint
 */
interface CountTokensBody {
  messages: MessagesRequestBody["messages"];
  tools?: MessagesRequestBody["tools"];
  system?: MessagesRequestBody["system"];
}

/**
 * Extended request type with access level
 */
interface AuthenticatedRequest extends FastifyRequest {
  accessLevel?: "full" | "restricted";
}

/**
 * Create and configure the router server instance
 *
 * Sets up all API endpoints for:
 * - Token counting (/v1/messages/count_tokens)
 * - Configuration management (/api/config)
 * - Transformer listing (/api/transformers)
 * - Service restart (/api/restart)
 * - Update management (/api/update/*)
 * - Log management (/api/logs/*)
 * - Static UI file serving (/ui/*)
 *
 * @param config - Server configuration object
 * @returns Configured Server instance from @musistudio/llms
 */
export const createServer = (config: ServerConfig): Server => {
  const server = new Server(config);

  server.app.post<{ Body: CountTokensBody }>("/v1/messages/count_tokens", async (req, reply) => {
    const { messages, tools, system } = req.body;
    const tokenCount = calculateTokenCount(
      messages as MessageParam[],
      system,
      (tools || []) as Tool[]
    );
    return { input_tokens: tokenCount };
  });

  // Add endpoint to read config.json with access control
  server.app.get("/api/config", async (_req: FastifyRequest, _reply: FastifyReply) => {
    return await readConfigFile();
  });

  server.app.get("/api/transformers", async () => {
    const transformers =
      server.app._server!.transformerService.getAllTransformers();
    type TransformerEntry = [string, { endPoint?: string }];
    const transformerList = Array.from(transformers.entries() as IterableIterator<TransformerEntry>).map(
      ([name, transformer]) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  server.app.post("/api/config", async (req: FastifyRequest<{ Body: Partial<AppConfig> }>, _reply: FastifyReply) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    return { success: true, message: "Config saved successfully" };
  });

  // Add endpoint to restart the service with access control
  server.app.post("/api/restart", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ success: true, message: "Service restart initiated" });

    // Restart the service after a short delay to allow response to be sent
    setTimeout(() => {
      const { spawn } = require("child_process");
      spawn(process.execPath, [process.argv[1], "restart"], {
        detached: true,
        stdio: "ignore",
      });
    }, 1000);
  });

  // Register static file serving with caching
  server.app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  server.app.get("/ui", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.redirect("/ui/");
  });

  // Version check endpoint
  server.app.get("/api/update/check", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      // Get current version
      const currentVersion = require("../package.json").version;
      const { hasUpdate, latestVersion, changelog } = await checkForUpdates(currentVersion);

      return {
        hasUpdate,
        latestVersion: hasUpdate ? latestVersion : undefined,
        changelog: hasUpdate ? changelog : undefined
      };
    } catch (error) {
      console.error("Failed to check for updates:", error);
      reply.status(500).send({ error: "Failed to check for updates" });
    }
  });

  // Perform update endpoint
  server.app.post("/api/update/perform", async (req: AuthenticatedRequest, reply: FastifyReply) => {
    try {
      // Only allow users with full access to perform updates
      const accessLevel = req.accessLevel || "restricted";
      if (accessLevel !== "full") {
        reply.status(403).send("Full access required to perform updates");
        return;
      }

      // Execute update logic
      const result = await performUpdate();

      return result;
    } catch (error) {
      console.error("Failed to perform update:", error);
      reply.status(500).send({ error: "Failed to perform update" });
    }
  });

  // Get log files list endpoint
  server.app.get("/api/logs/files", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: LogFileInfo[] = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // Sort by modification time in descending order
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // Get log content endpoint
  server.app.get("/api/logs", async (req: FastifyRequest<{ Querystring: LogsQueryParams }>, reply: FastifyReply) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const filePath = req.query.file;
      let logFilePath: string;

      if (filePath) {
        // Validate path is within logs directory to prevent path traversal
        if (!isPathWithinLogsDir(filePath, logDir)) {
          reply.status(403).send({ error: "Access denied: path outside logs directory" });
          return;
        }
        logFilePath = filePath;
      } else {
        // If no file path is specified, use the default log file path
        logFilePath = join(logDir, "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // Clear log content endpoint
  server.app.delete("/api/logs", async (req: FastifyRequest<{ Querystring: LogsQueryParams }>, reply: FastifyReply) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const filePath = req.query.file;
      let logFilePath: string;

      if (filePath) {
        // Validate path is within logs directory to prevent path traversal
        if (!isPathWithinLogsDir(filePath, logDir)) {
          reply.status(403).send({ error: "Access denied: path outside logs directory" });
          return;
        }
        logFilePath = filePath;
      } else {
        // If no file path is specified, use the default log file path
        logFilePath = join(logDir, "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  return server;
};
