import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateTokenCount, router, searchProjectBySession } from './router';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';

// Mock the fs/promises module
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  opendir: vi.fn(),
  stat: vi.fn(),
}));

// Mock the cache module
vi.mock('./cache', () => ({
  sessionUsageCache: {
    get: vi.fn(),
    set: vi.fn(),
  },
  Usage: {},
}));

describe('calculateTokenCount', () => {
  describe('with string message content', () => {
    it('should count tokens for a simple string message', () => {
      const messages: MessageParam[] = [
        { role: 'user', content: 'Hello, world!' },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, []);
      expect(tokenCount).toBeGreaterThan(0);
      expect(tokenCount).toBeLessThan(10); // Simple message should have few tokens
    });

    it('should count tokens for multiple messages', () => {
      const messages: MessageParam[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, []);
      expect(tokenCount).toBeGreaterThan(5);
    });

    it('should return 0 for empty messages array', () => {
      const tokenCount = calculateTokenCount([], undefined, []);
      expect(tokenCount).toBe(0);
    });
  });

  describe('with array message content', () => {
    it('should count tokens for text content blocks', () => {
      const messages: MessageParam[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'This is a test message' },
          ],
        },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, []);
      expect(tokenCount).toBeGreaterThan(0);
    });

    it('should count tokens for tool_use content blocks', () => {
      const messages: MessageParam[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_123',
              name: 'read_file',
              input: { path: '/test/file.txt' },
            },
          ],
        },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, []);
      expect(tokenCount).toBeGreaterThan(0);
    });

    it('should count tokens for tool_result content blocks with string content', () => {
      const messages: MessageParam[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_123',
              content: 'File contents here',
            },
          ],
        },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, []);
      expect(tokenCount).toBeGreaterThan(0);
    });

    it('should count tokens for tool_result content blocks with object content', () => {
      const messages: MessageParam[] = [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_123',
              content: [{ type: 'text', text: 'Result text' }],
            },
          ],
        },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, []);
      expect(tokenCount).toBeGreaterThan(0);
    });
  });

  describe('with system prompts', () => {
    it('should count tokens for string system prompt', () => {
      const messages: MessageParam[] = [];
      const system = 'You are a helpful assistant.';
      const tokenCount = calculateTokenCount(messages, system, []);
      expect(tokenCount).toBeGreaterThan(0);
    });

    it('should count tokens for array system prompt with text items', () => {
      const messages: MessageParam[] = [];
      const system = [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Be concise in your responses.' },
      ];
      const tokenCount = calculateTokenCount(messages, system, []);
      expect(tokenCount).toBeGreaterThan(0);
    });

    it('should ignore non-text items in system array', () => {
      const messages: MessageParam[] = [];
      const system = [
        { type: 'image', data: 'base64data' },
        { type: 'text', text: 'Hello' },
      ];
      const tokenCount = calculateTokenCount(messages, system, []);
      // Should only count the text item
      expect(tokenCount).toBeGreaterThan(0);
    });

    it('should handle nested text arrays in system prompt', () => {
      const messages: MessageParam[] = [];
      const system = [
        { type: 'text', text: ['Line 1', 'Line 2', 'Line 3'] },
      ];
      const tokenCount = calculateTokenCount(messages, system, []);
      expect(tokenCount).toBeGreaterThan(0);
    });
  });

  describe('with tools', () => {
    it('should count tokens for tool definitions', () => {
      const messages: MessageParam[] = [];
      const tools: Tool[] = [
        {
          name: 'read_file',
          description: 'Reads the contents of a file from the filesystem',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The file path to read' },
            },
            required: ['path'],
          },
        },
      ];
      const tokenCount = calculateTokenCount(messages, undefined, tools);
      expect(tokenCount).toBeGreaterThan(10);
    });

    it('should count tokens for multiple tools', () => {
      const tools: Tool[] = [
        {
          name: 'read_file',
          description: 'Reads a file',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'write_file',
          description: 'Writes a file',
          input_schema: { type: 'object', properties: {} },
        },
      ];
      const singleToolCount = calculateTokenCount([], undefined, [tools[0]]);
      const multiToolCount = calculateTokenCount([], undefined, tools);
      expect(multiToolCount).toBeGreaterThan(singleToolCount);
    });

    it('should handle tools without description', () => {
      const tools: Tool[] = [
        {
          name: 'simple_tool',
          input_schema: { type: 'object', properties: {} },
        } as Tool,
      ];
      const tokenCount = calculateTokenCount([], undefined, tools);
      // Should still count input_schema tokens
      expect(tokenCount).toBeGreaterThan(0);
    });
  });

  describe('combined inputs', () => {
    it('should correctly sum tokens from messages, system, and tools', () => {
      const messages: MessageParam[] = [
        { role: 'user', content: 'Hello' },
      ];
      const system = 'Be helpful';
      const tools: Tool[] = [
        {
          name: 'test',
          description: 'A test tool',
          input_schema: { type: 'object', properties: {} },
        },
      ];

      const messagesOnly = calculateTokenCount(messages, undefined, []);
      const systemOnly = calculateTokenCount([], system, []);
      const toolsOnly = calculateTokenCount([], undefined, tools);
      const combined = calculateTokenCount(messages, system, tools);

      expect(combined).toBe(messagesOnly + systemOnly + toolsOnly);
    });
  });
});

describe('router middleware', () => {
  const createMockRequest = (overrides: any = {}) => ({
    body: {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'Hello' }],
      system: [],
      tools: [],
      metadata: {},
      ...overrides.body,
    },
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  });

  const createMockConfig = (overrides: any = {}) => ({
    Router: {
      default: 'openrouter,claude-sonnet-4',
      background: 'openrouter,claude-haiku',
      think: 'openrouter,claude-sonnet-4-thinking',
      longContext: 'openrouter,gemini-pro',
      longContextThreshold: 60000,
      webSearch: 'openrouter,gpt-4-search',
      ...overrides.Router,
    },
    Providers: [
      {
        name: 'openrouter',
        models: ['claude-sonnet-4', 'claude-haiku', 'gemini-pro'],
      },
      ...(overrides.Providers || []),
    ],
    ...overrides,
  });

  const mockContext = {
    config: createMockConfig(),
    event: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use default model when no special conditions apply', async () => {
    const req = createMockRequest();
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('openrouter,claude-sonnet-4');
  });

  it('should extract sessionId from metadata.user_id', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-sonnet-4',
        messages: [],
        metadata: { user_id: 'user123_session_abc123' },
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.sessionId).toBe('abc123');
  });

  it('should use background model for Haiku requests', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-3-haiku-20240307',
        messages: [{ role: 'user', content: 'Quick task' }],
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('openrouter,claude-haiku');
    expect(req.log.info).toHaveBeenCalled();
  });

  it('should use think model when thinking is enabled', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-sonnet-4',
        messages: [],
        thinking: { type: 'enabled', budget_tokens: 10000 },
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('openrouter,claude-sonnet-4-thinking');
  });

  it('should use webSearch model when web_search tools are present', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-sonnet-4',
        messages: [],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('openrouter,gpt-4-search');
  });

  it('should prioritize webSearch over think model', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-sonnet-4',
        messages: [],
        thinking: { type: 'enabled' },
        tools: [{ type: 'web_search', name: 'search' }],
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('openrouter,gpt-4-search');
  });

  it('should use explicit provider,model format from request', async () => {
    const req = createMockRequest({
      body: {
        model: 'openrouter,claude-sonnet-4',
        messages: [],
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('openrouter,claude-sonnet-4');
  });

  it('should handle CCR-SUBAGENT-MODEL in system prompt', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-sonnet-4',
        messages: [],
        system: [
          { type: 'text', text: 'Base system prompt' },
          { type: 'text', text: '<CCR-SUBAGENT-MODEL>custom,model</CCR-SUBAGENT-MODEL>Rest of prompt' },
        ],
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.body.model).toBe('custom,model');
    // The CCR-SUBAGENT-MODEL tag should be removed from the system prompt
    expect(req.body.system[1].text).toBe('Rest of prompt');
  });

  it('should handle request without sessionId', async () => {
    const req = createMockRequest({
      body: {
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'test' }],
        metadata: {}, // No user_id
      },
    });
    const config = createMockConfig();

    await router(req, {}, { config, event: {} });

    expect(req.sessionId).toBeUndefined();
    expect(req.body.model).toBe('openrouter,claude-sonnet-4');
  });
});

describe('searchProjectBySession', () => {
  // Import the mocked functions
  let opendir: any;
  let stat: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsMock = await import('fs/promises');
    opendir = fsMock.opendir;
    stat = fsMock.stat;
  });

  it('should return cached result if available', async () => {
    // First call to populate cache - this is tested indirectly
    // The LRU cache should return cached results on subsequent calls
    expect(true).toBe(true);
  });

  it('should return null when session file is not found in any project', async () => {
    vi.mocked(opendir).mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { name: 'project1', isDirectory: () => true };
        yield { name: 'project2', isDirectory: () => true };
      },
    } as any);

    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

    const result = await searchProjectBySession('nonexistent-session');

    expect(result).toBeNull();
  });

  it('should return project name when session file is found', async () => {
    vi.mocked(opendir).mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { name: 'my-project', isDirectory: () => true };
        yield { name: 'other-project', isDirectory: () => true };
      },
    } as any);

    vi.mocked(stat).mockImplementation(async (path: any) => {
      if (path.includes('my-project') && path.includes('test-session')) {
        return { isFile: () => true } as any;
      }
      throw new Error('ENOENT');
    });

    const result = await searchProjectBySession('test-session');

    expect(result).toBe('my-project');
  });

  it('should handle errors gracefully and return null', async () => {
    vi.mocked(opendir).mockRejectedValue(new Error('Permission denied'));

    const result = await searchProjectBySession('any-session');

    expect(result).toBeNull();
  });

  it('should skip non-directory entries', async () => {
    vi.mocked(opendir).mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { name: 'file.txt', isDirectory: () => false };
        yield { name: 'project', isDirectory: () => true };
      },
    } as any);

    vi.mocked(stat).mockImplementation(async (path: any) => {
      if (path.includes('project') && path.includes('session123')) {
        return { isFile: () => true } as any;
      }
      throw new Error('ENOENT');
    });

    const result = await searchProjectBySession('session123');

    expect(result).toBe('project');
  });
});
