import path from "node:path";
import os from "node:os";

export const HOME_DIR = path.join(os.homedir(), ".claude-code-router");

export const CONFIG_FILE = path.join(HOME_DIR, "config.json");

export const PLUGINS_DIR = path.join(HOME_DIR, "plugins");

export const PID_FILE = path.join(HOME_DIR, '.claude-code-router.pid');

export const REFERENCE_COUNT_FILE = path.join(os.tmpdir(), "claude-code-reference-count.txt");

// Claude projects directory
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Router thresholds and limits
export const DEFAULT_LONG_CONTEXT_THRESHOLD = 60000;
export const DEFAULT_PORT = 3456;
export const MAX_PID_VALUE = 4194304;

// Timeouts (in milliseconds)
export const INTERNAL_FETCH_TIMEOUT_MS = 30000;
export const DEFAULT_API_TIMEOUT_MS = 600000;

export const DEFAULT_CONFIG = {
  LOG: false,
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_MODEL: "",
};
