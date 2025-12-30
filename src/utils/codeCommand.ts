import { spawn, type StdioOptions } from "child_process";
import { readConfigFile } from ".";
import { closeService } from "./close";
import {
  decrementReferenceCount,
  incrementReferenceCount,
} from "./processCheck";
import minimist from "minimist";
import { createEnvVariables } from "./createEnvVariables";
import type { SettingsFlag, EnvironmentVariables, AppConfig } from "../types";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Extended config interface with optional fields used in code command
 */
interface CodeCommandConfig {
  PORT?: number;
  APIKEY?: string;
  NON_INTERACTIVE_MODE?: boolean;
  CLAUDE_PATH?: string;
  API_TIMEOUT_MS?: number;
  ANTHROPIC_SMALL_FAST_MODEL?: string;
  StatusLine?: {
    enabled?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Execute the Claude Code command with proper environment setup
 * @param args Command line arguments to pass to Claude
 */
export async function executeCodeCommand(args: string[] = []): Promise<void> {
  // Set environment variables using shared function
  const config = await readConfigFile() as CodeCommandConfig;
  const env = await createEnvVariables() as EnvironmentVariables;
  const settingsFlag: SettingsFlag = {
    env
  };
  if (config?.StatusLine?.enabled) {
    settingsFlag.statusLine = {
      type: "command",
      command: "ccr statusline",
      padding: 0,
    };
  }
  // args.push('--settings', `${JSON.stringify(settingsFlag)}`);

  // Non-interactive mode for automation environments
  if (config.NON_INTERACTIVE_MODE) {
    env.CI = "true";
    env.FORCE_COLOR = "0";
    env.NODE_NO_READLINE = "1";
    env.TERM = "dumb";
  }

  // Set ANTHROPIC_SMALL_FAST_MODEL if it exists in config
  if (config?.ANTHROPIC_SMALL_FAST_MODEL) {
    env.ANTHROPIC_SMALL_FAST_MODEL = config.ANTHROPIC_SMALL_FAST_MODEL;
  }

  // Increment reference count when command starts
  incrementReferenceCount();

  // Execute claude command - validate path to prevent command injection
  let claudePath = config?.CLAUDE_PATH || process.env.CLAUDE_PATH || "claude";

  // If a custom path is specified, validate it exists and is not a shell command
  if (claudePath !== "claude") {
    const resolvedPath = resolve(claudePath);
    // Only allow paths that don't contain shell metacharacters
    if (/[;&|`$(){}[\]<>!]/.test(claudePath)) {
      console.error("Invalid CLAUDE_PATH: contains shell metacharacters");
      decrementReferenceCount();
      process.exit(1);
    }
    claudePath = resolvedPath;
  }

  const stdioConfig: StdioOptions = config.NON_INTERACTIVE_MODE
    ? ["pipe", "inherit", "inherit"] // Pipe stdin for non-interactive
    : "inherit"; // Default inherited behavior

  // Build arguments array safely without shell interpretation
  const argsObj = minimist(args);
  const argsArr: string[] = [];

  // Add positional arguments first
  if (argsObj._ && argsObj._.length > 0) {
    argsArr.push(...argsObj._.map(String));
  }

  // Add flag arguments
  for (const [key, value] of Object.entries(argsObj)) {
    if (key !== '_' && value !== undefined && value !== false) {
      const prefix = key.length === 1 ? '-' : '--';
      if (value === true) {
        argsArr.push(`${prefix}${key}`);
      } else {
        argsArr.push(`${prefix}${key}`, String(value));
      }
    }
  }

  // Spawn without shell to prevent command injection
  const claudeProcess = spawn(
    claudePath,
    argsArr,
    {
      env: {
        ...process.env,
        ...env
      },
      stdio: stdioConfig,
      // shell: false is the default, explicitly not using shell
    }
  );

  // Close stdin for non-interactive mode
  if (config.NON_INTERACTIVE_MODE) {
    claudeProcess.stdin?.end();
  }

  claudeProcess.on("error", (error) => {
    console.error("Failed to start claude command:", error.message);
    console.log(
      "Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code"
    );
    decrementReferenceCount();
    process.exit(1);
  });

  claudeProcess.on("close", (code) => {
    decrementReferenceCount();
    closeService();
    process.exit(code || 0);
  });
}
