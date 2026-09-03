export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured size limit.');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Read a request body while enforcing the byte limit even for chunked requests. */
export async function readRequestText(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error('Invalid Content-Length header.');
    }
    if (parsedLength > maximumBytes) throw new RequestBodyTooLargeError();
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let receivedBytes = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        try { await reader.cancel(); } catch {}
        throw new RequestBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw new Error('Request body is not valid UTF-8.');
  }
}

export async function readRequestJson(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  return JSON.parse(await readRequestText(request, maximumBytes)) as unknown;
}
