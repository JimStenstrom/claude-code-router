/**
 * Type declarations for external modules without TypeScript definitions
 */

declare module '@musistudio/llms' {
  import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

  interface ServerOptions {
    jsonPath: string;
    initialConfig: {
      providers: unknown[];
      HOST: string;
      PORT: number;
      LOG_FILE: string;
    };
    logger: {
      level: string;
      stream: NodeJS.WritableStream;
    } | false;
  }

  interface TransformerService {
    getAllTransformers(): Map<string, { endPoint?: string }>;
  }

  interface ServerInstance {
    transformerService: TransformerService;
  }

  type PreHandler = (
    request: FastifyRequest,
    reply: FastifyReply
  ) => Promise<void> | void;

  type ErrorHookHandler = (
    request: FastifyRequest,
    reply: FastifyReply,
    error: Error
  ) => Promise<void> | void;

  type OnSendHandler<T = unknown> = (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: T,
    done: (err: Error | null, payload: unknown) => void
  ) => void | T;

  type OnSendAsyncHandler<T = unknown> = (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: T
  ) => Promise<T>;

  class Server {
    app: FastifyInstance & { _server?: ServerInstance };
    logger: {
      error: (...args: unknown[]) => void;
      info: (...args: unknown[]) => void;
      debug: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
    };
    constructor(options: ServerOptions);
    start(): void;
    addHook(name: 'preHandler', handler: PreHandler): void;
    addHook(name: 'onError', handler: ErrorHookHandler): void;
    addHook(name: 'onSend', handler: OnSendHandler | OnSendAsyncHandler): void;
  }

  export default Server;
}

declare module 'shell-quote' {
  /**
   * Quote an array of strings for use in a shell command
   */
  export function quote(args: string[]): string;

  /**
   * Parse a shell command string into an array of arguments
   */
  export function parse(cmd: string): string[];
}

declare module 'minimist' {
  interface ParsedArgs {
    _: string[];
    [key: string]: string | boolean | string[] | undefined;
  }

  interface Options {
    string?: string | string[];
    boolean?: string | string[];
    alias?: { [key: string]: string | string[] };
    default?: { [key: string]: unknown };
    stopEarly?: boolean;
    '--'?: boolean;
    unknown?: (arg: string) => boolean;
  }

  function minimist(args: string[], opts?: Options): ParsedArgs;
  export = minimist;
}
