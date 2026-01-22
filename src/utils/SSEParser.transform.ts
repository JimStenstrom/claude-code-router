import type { ParsedSSEEvent, SSEEventData } from "../types";

/**
 * SSE data type including special cases
 */
type SSEData = SSEEventData | { type: "done" } | { raw: string; error: string };

/**
 * Transform stream that parses Server-Sent Events from a byte stream
 * Converts raw SSE text format into structured ParsedSSEEvent objects
 */
export class SSEParserTransform extends TransformStream<Uint8Array, ParsedSSEEvent> {
    private buffer = '';
    private currentEvent: ParsedSSEEvent = {};

    constructor() {
        super({
            transform: (chunk: Uint8Array, controller: TransformStreamDefaultController<ParsedSSEEvent>) => {
                const decoder = new TextDecoder();
                const text = decoder.decode(chunk);
                this.buffer += text;
                const lines = this.buffer.split('\n');

                // Keep the last line (may be incomplete)
                this.buffer = lines.pop() || '';

                for (const line of lines) {
                    const event = this.processLine(line);
                    if (event) {
                        controller.enqueue(event);
                    }
                }
            },
            flush: (controller: TransformStreamDefaultController<ParsedSSEEvent>) => {
                // Process remaining content in buffer
                if (this.buffer.trim()) {
                    const events: ParsedSSEEvent[] = [];
                    this.processLine(this.buffer.trim(), events);
                    events.forEach(event => controller.enqueue(event));
                }

                // Push the last event (if any)
                if (Object.keys(this.currentEvent).length > 0) {
                    controller.enqueue(this.currentEvent);
                }
            }
        });
    }

    /**
     * Process a single line of SSE data
     * @param line The line to process
     * @param events Optional array to collect events during flush
     * @returns Parsed event or null if line is incomplete
     */
    private processLine(line: string, events?: ParsedSSEEvent[]): ParsedSSEEvent | null {
        if (!line.trim()) {
            if (Object.keys(this.currentEvent).length > 0) {
                const event = { ...this.currentEvent };
                this.currentEvent = {};
                if (events) {
                    events.push(event);
                    return null;
                }
                return event;
            }
            return null;
        }

        if (line.startsWith('event:')) {
            this.currentEvent.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
                this.currentEvent.data = { type: 'done' };
            } else {
                try {
                    this.currentEvent.data = JSON.parse(data) as SSEData;
                } catch {
                    this.currentEvent.data = { raw: data, error: 'JSON parse failed' };
                }
            }
        } else if (line.startsWith('id:')) {
            this.currentEvent.id = line.slice(3).trim();
        } else if (line.startsWith('retry:')) {
            this.currentEvent.retry = parseInt(line.slice(6).trim(), 10);
        }
        return null;
    }
}
