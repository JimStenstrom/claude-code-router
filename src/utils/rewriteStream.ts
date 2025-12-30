/**
 * Reads from a source ReadableStream and returns a new ReadableStream.
 * The processor transforms the source data and pushes the returned value to the new stream.
 * If no value is returned from the processor, nothing is pushed.
 * @param stream Source ReadableStream to read from
 * @param processor Function to process each chunk of data
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
