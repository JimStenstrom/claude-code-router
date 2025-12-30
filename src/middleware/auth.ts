import { FastifyRequest, FastifyReply } from "fastify";

/**
 * Auth middleware configuration
 */
interface AuthConfig {
  APIKEY?: string;
  PORT?: number;
}

export const apiKeyAuth =
  (config: AuthConfig) =>
  async (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    // Public endpoints that don't require authentication
    if (["/", "/health"].includes(req.url) || req.url.startsWith("/ui")) {
      return done();
    }

    const apiKey = config.APIKEY;
    if (!apiKey) {
      // If no API key is set, enable CORS for local origins only
      const port = config.PORT || 3456;
      const allowedOrigins = [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
      ];
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        reply.status(403).send("CORS not allowed for this origin");
        return;
      } else if (origin && allowedOrigins.includes(origin)) {
        // Set the matching origin (fixes duplicate header issue)
        reply.header('Access-Control-Allow-Origin', origin);
      }
      return done();
    }

    const authHeaderValue =
      req.headers.authorization || req.headers["x-api-key"];
    const authKey: string = Array.isArray(authHeaderValue)
      ? authHeaderValue[0]
      : authHeaderValue || "";
    if (!authKey) {
      reply.status(401).send("APIKEY is missing");
      return;
    }
    let token = "";
    if (authKey.startsWith("Bearer")) {
      token = authKey.split(" ")[1];
    } else {
      token = authKey;
    }

    if (token !== apiKey) {
      reply.status(401).send("Invalid API key");
      return;
    }

    done();
  };
