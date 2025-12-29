/**
 * Reads from a source ReadableStream and returns a new ReadableStream.
 * The processor processes source data and pushes returned values to the new stream.
 * If no value is returned, nothing is pushed.
 * @param stream - The source ReadableStream to read from
 * @param processor - Function to process each chunk and optionally return transformed data
 */
export const rewriteStream = (stream: ReadableStream, processor: (data: any, controller: ReadableStreamController<any>) => Promise<any>): ReadableStream => {
  const reader = stream.getReader()

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            break
          }

          const processed = await processor(value, controller)
          if (processed !== undefined) {
            controller.enqueue(processed)
          }
        }
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    }
  })
}
