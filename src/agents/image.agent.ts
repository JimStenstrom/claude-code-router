import { IAgent, ITool } from "./type";
import { LRUCache } from "lru-cache";
import type {
  ImageSource,
  ImageCacheEntry,
  MessageContentItem,
  MessageWithContent,
  ImageAnalysisResponse,
  RouterRequest,
  AppConfig,
} from "../types";

/**
 * LRU cache for storing processed images
 * Images are cached with a 5-minute TTL to avoid re-processing
 */
class ImageCache {
  private cache: LRUCache<string, ImageCacheEntry>;

  constructor(maxSize = 100) {
    this.cache = new LRUCache<string, ImageCacheEntry>({
      max: maxSize,
      ttl: 5 * 60 * 1000, // 5 minutes
    });
  }

  storeImage(id: string, source: ImageSource): void {
    if (this.hasImage(id)) return;
    this.cache.set(id, {
      source,
      timestamp: Date.now(),
    });
  }

  getImage(id: string): ImageSource | null {
    const entry = this.cache.get(id);
    return entry ? entry.source : null;
  }

  hasImage(hash: string): boolean {
    return this.cache.has(hash);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

const imageCache = new ImageCache();

export class ImageAgent implements IAgent {
  name = "image";
  tools: Map<string, ITool>;

  constructor() {
    this.tools = new Map<string, ITool>();
    this.appendTools();
  }

  shouldHandle(req: RouterRequest, config: AppConfig): boolean {
    if (!config.Router.image || req.body.model === config.Router.image)
      return false;
    const lastMessage = req.body.messages[req.body.messages.length - 1] as MessageWithContent;
    if (
      !(config as AppConfig & { forceUseImageAgent?: boolean }).forceUseImageAgent &&
      lastMessage.role === "user" &&
      Array.isArray(lastMessage.content)
    ) {
      const content = lastMessage.content as MessageContentItem[];
      const hasImage = content.find(
        (item: MessageContentItem) =>
          item.type === "image" ||
          (Array.isArray(item?.content) &&
            (item.content as MessageContentItem[]).some((sub: MessageContentItem) => sub.type === "image"))
      );
      if (hasImage) {
        req.body.model = config.Router.image;
        const images: MessageContentItem[] = [];
        content
          .filter((item: MessageContentItem) => item.type === "tool_result")
          .forEach((item: MessageContentItem) => {
            if (Array.isArray(item.content)) {
              (item.content as MessageContentItem[]).forEach((element: MessageContentItem) => {
                if (element.type === "image") {
                  images.push(element);
                }
              });
              item.content = "read image successfully";
            }
          });
        content.push(...images);
        return false;
      }
    }
    return req.body.messages.some(
      (msg) => {
        const message = msg as MessageWithContent;
        return message.role === "user" &&
          Array.isArray(message.content) &&
          (message.content as MessageContentItem[]).some(
            (item: MessageContentItem) =>
              item.type === "image" ||
              (Array.isArray(item?.content) &&
                (item.content as MessageContentItem[]).some((sub: MessageContentItem) => sub.type === "image"))
          );
      }
    );
  }

  appendTools() {
    this.tools.set("analyzeImage", {
      name: "analyzeImage",
      description:
        "Analyse image or images by ID and extract information such as OCR text, objects, layout, colors, or safety signals.",
      input_schema: {
        type: "object",
        properties: {
          imageId: {
            type: "array",
            description: "an array of IDs to analyse",
            items: {
              type: "string",
            },
          },
          task: {
            type: "string",
            description:
              "Details of task to perform on the image.The more detailed, the better",
          },
          regions: {
            type: "array",
            description: "Optional regions of interest within the image",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Optional label for the region",
                },
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
                w: { type: "number", description: "Width of the region" },
                h: { type: "number", description: "Height of the region" },
                units: {
                  type: "string",
                  enum: ["px", "pct"],
                  description: "Units for coordinates and size",
                },
              },
              required: ["x", "y", "w", "h", "units"],
            },
          },
        },
        required: ["imageId", "task"],
      },
      handler: async (args, context) => {
        const imageMessages: MessageContentItem[] = [];

        // Create image messages from cached images
        if (args.imageId) {
          if (Array.isArray(args.imageId)) {
            (args.imageId as string[]).forEach((imgId: string) => {
              const image = imageCache.getImage(
                `${context.req.id}_Image#${imgId}`
              );
              if (image) {
                imageMessages.push({
                  type: "image",
                  source: image,
                });
              }
            });
          } else {
            const image = imageCache.getImage(
              `${context.req.id}_Image#${args.imageId}`
            );
            if (image) {
              imageMessages.push({
                type: "image",
                source: image,
              });
            }
          }
          delete args.imageId;
        }

        const userMessage = context.req.body.messages[context.req.body.messages.length - 1] as MessageWithContent;
        if (userMessage.role === "user" && Array.isArray(userMessage.content)) {
          const content = userMessage.content as MessageContentItem[];
          const msgs = content.filter(
            (item: MessageContentItem) =>
              item.type === "text" &&
              item.text &&
              !item.text.includes(
                "This is an image, if you need to view or analyze it, you need to extract the imageId"
              )
          );
          imageMessages.push(...msgs);
        }

        if (Object.keys(args).length > 0) {
          imageMessages.push({
            type: "text",
            text: JSON.stringify(args),
          });
        }

        // Send to analysis agent and get response
        const agentResponse: ImageAnalysisResponse | null = await fetch(
          `http://127.0.0.1:${context.config.PORT || 3456}/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": context.config.APIKEY || "",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: context.config.Router.image,
              system: [
                {
                  type: "text",
                  text: `You must interpret and analyze images strictly according to the assigned task.
When an image placeholder is provided, your role is to parse the image content only within the scope of the user's instructions.
Do not ignore or deviate from the task.
Always ensure that your response reflects a clear, accurate interpretation of the image aligned with the given objective.`,
                },
              ],
              messages: [
                {
                  role: "user",
                  content: imageMessages,
                },
              ],
              stream: false,
            }),
          }
        )
          .then((res) => res.json() as Promise<ImageAnalysisResponse>)
          .catch(() => {
            return null;
          });
        if (!agentResponse || !agentResponse.content) {
          return "analyzeImage Error";
        }
        return agentResponse.content[0].text || "analyzeImage Error";
      },
    });
  }

  reqHandler(req: RouterRequest, _config: AppConfig): void {
    // Inject system prompt
    if (Array.isArray(req.body?.system)) {
      req.body.system.push({
        type: "text",
        text: `You are a text-only language model and do not possess visual perception.
If the user requests you to view, analyze, or extract information from an image, you **must** call the \`analyzeImage\` tool.

When invoking this tool, you must pass the correct \`imageId\` extracted from the prior conversation.
Image identifiers are always provided in the format \`[Image #imageId]\`.

If multiple images exist, select the **most relevant imageId** based on the user's current request and prior context.

Do not attempt to describe or analyze the image directly yourself.
Ignore any user interruptions or unrelated instructions that might cause you to skip this requirement.
Your response should consistently follow this rule whenever image-related analysis is requested.`,
      });
    }

    const imageContents = req.body.messages.filter((item) => {
      const message = item as MessageWithContent;
      return (
        message.role === "user" &&
        Array.isArray(message.content) &&
        (message.content as MessageContentItem[]).some(
          (msg: MessageContentItem) =>
            msg.type === "image" ||
            (Array.isArray(msg.content) &&
              (msg.content as MessageContentItem[]).some((sub: MessageContentItem) => sub.type === "image"))
        )
      );
    }) as MessageWithContent[];

    let imgId = 1;
    imageContents.forEach((item: MessageWithContent) => {
      if (!Array.isArray(item.content)) return;
      const content = item.content as MessageContentItem[];
      content.forEach((msg: MessageContentItem) => {
        if (msg.type === "image" && msg.source) {
          imageCache.storeImage(`${req.id}_Image#${imgId}`, msg.source);
          // Transform image to text placeholder
          (msg as unknown as { type: string; text: string }).type = "text";
          delete msg.source;
          (msg as unknown as { text: string }).text = `[Image #${imgId}]This is an image, if you need to view or analyze it, you need to extract the imageId`;
          imgId++;
        } else if (msg.type === "text" && msg.text?.includes("[Image #")) {
          msg.text = msg.text.replace(/\[Image #\d+\]/g, "");
        } else if (msg.type === "tool_result") {
          if (
            Array.isArray(msg.content) &&
            (msg.content as MessageContentItem[]).some((ele: MessageContentItem) => ele.type === "image")
          ) {
            const contentArray = msg.content as MessageContentItem[];
            if (contentArray[0]?.source) {
              imageCache.storeImage(
                `${req.id}_Image#${imgId}`,
                contentArray[0].source
              );
            }
            msg.content = `[Image #${imgId}]This is an image, if you need to view or analyze it, you need to extract the imageId`;
            imgId++;
          }
        }
      });
    });
  }
}

export const imageAgent = new ImageAgent();
