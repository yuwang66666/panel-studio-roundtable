import { AppError } from './errors';

type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic';
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

function stringAt(source: string, start: number) {
  if (source[start] !== '"') return null;
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '"') return { value, end: i + 1, complete: true };
    if (char === '\\') {
      const escaped = source[++i];
      if (escaped === undefined) break;
      if (escaped === 'u') {
        const hex = source.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(hex)) break;
        value += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else {
        const escapes: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        if (!(escaped in escapes)) break;
        value += escapes[escaped];
      }
    } else {
      if (char.charCodeAt(0) < 32) break;
      value += char;
    }
  }
  // A UTF-16 pair can be split between provider deltas, including JSON unicode escapes.
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  return { value, end: source.length, complete: false };
}

function space(source: string, index: number) {
  while (/\s/.test(source[index] || '') && index < source.length) index++;
  return index;
}

// Skip only complete JSON values; nested public-looking keys must never become speech.
function skipValue(source: string, start: number): number | null {
  if (source[start] === '"') {
    const parsed = stringAt(source, start);
    return parsed?.complete ? parsed.end : null;
  }
  if (source[start] === '{' || source[start] === '[') {
    const stack = [source[start]];
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === '"') {
        const parsed = stringAt(source, i);
        if (!parsed?.complete) return null;
        i = parsed.end - 1;
      } else if (source[i] === '{' || source[i] === '[') stack.push(source[i]);
      else if (source[i] === '}' || source[i] === ']') {
        const expected = source[i] === '}' ? '{' : '[';
        if (stack.pop() !== expected) return null;
        if (!stack.length) return i + 1;
      }
    }
    return null;
  }
  const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/.exec(
    source.slice(start),
  );
  return scalar ? start + scalar[0].length : null;
}

/** Project a partial JSON object into public speech, never reasoning or JSON scaffolding. */
export function projectSpeechText(raw: string, purpose: string): string {
  const field =
    purpose === 'utterance'
      ? 'sentences'
      : ['opening', 'probe', 'summary'].includes(purpose)
        ? 'content'
        : null;
  if (!field) return '';
  let source = raw.trimStart();
  if (source.startsWith('```')) {
    const fence = /^```(?:json)?\s*(?=\{)/i.exec(source);
    if (!fence) return '';
    source = source.slice(fence[0].length);
  }
  if (source[0] !== '{') return '';
  let i = space(source, 1);
  while (i < source.length) {
    const key = stringAt(source, i);
    if (!key?.complete) return '';
    i = space(source, key.end);
    if (source[i] !== ':') return '';
    i = space(source, i + 1);
    if (key.value === field) {
      if (field === 'content') return stringAt(source, i)?.value || '';
      if (source[i] !== '[') return '';
      let text = '';
      i = space(source, i + 1);
      while (i < source.length && source[i] !== ']') {
        const sentence = stringAt(source, i);
        if (!sentence) return text;
        text += sentence.value;
        if (!sentence.complete) return text;
        i = space(source, sentence.end);
        if (source[i] !== ',') return text;
        i = space(source, i + 1);
      }
      return text;
    }
    const end = skipValue(source, i);
    if (end === null) return '';
    i = space(source, end);
    if (source[i] !== ',') return '';
    i = space(source, i + 1);
  }
  return '';
}

const streamError = () => new AppError('UPSTREAM_STREAM', '模型流式响应中断或格式无效', 502);
const usageNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Consume vendor SSE envelopes. Only public text deltas leave this parser. */
export async function readModelStream(
  response: Response,
  protocol: Protocol,
  onText: (rawText: string) => void,
  onUsage: (usage: StreamUsage) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw streamError();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    dataLines: string[] = [],
    eventName = '',
    text = '',
    size = 0;
  let complete = false,
    chatFinished = false;
  let anthropicStopped = false;
  let usage: StreamUsage = { inputTokens: 0, outputTokens: 0 };
  const append = (delta: unknown) => {
    if (typeof delta !== 'string') return;
    text += delta;
    onText(text);
  };
  const setUsage = (value: any) => {
    if (!value || typeof value !== 'object') return;
    usage = {
      inputTokens:
        value.input_tokens !== undefined || value.prompt_tokens !== undefined
          ? usageNumber(value.input_tokens ?? value.prompt_tokens)
          : usage.inputTokens,
      outputTokens:
        value.output_tokens !== undefined || value.completion_tokens !== undefined
          ? usageNumber(value.output_tokens ?? value.completion_tokens)
          : usage.outputTokens,
    };
    onUsage(usage);
  };
  const dispatch = () => {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const raw = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';
    if (raw === '[DONE]') {
      if (protocol !== 'openai-chat' || !chatFinished) throw streamError();
      complete = true;
      return;
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw streamError();
    }
    if (!data || typeof data !== 'object') throw streamError();
    const type = typeof data.type === 'string' ? data.type : name;
    if (
      data.error ||
      type === 'error' ||
      type === 'response.failed' ||
      type === 'response.incomplete'
    )
      throw new AppError('UPSTREAM_STREAM', '模型服务未完成流式响应', 502);
    if (protocol === 'openai-chat') {
      setUsage(data.usage);
      const choice = data.choices?.[0];
      if (choice?.finish_reason != null) {
        if (choice.finish_reason !== 'stop') throw streamError();
        chatFinished = true;
      }
      append(choice?.delta?.content);
    } else if (protocol === 'openai-responses') {
      if (type === 'response.output_text.delta') append(data.delta);
      if (type === 'response.completed') {
        if (data.response?.status && data.response.status !== 'completed') throw streamError();
        setUsage(data.response?.usage);
        if (!text) {
          const output = data.response?.output;
          if (Array.isArray(output))
            append(
              output
                .filter((x: any) => x.type === 'message')
                .flatMap((x: any) => (Array.isArray(x.content) ? x.content : []))
                .filter((x: any) => x.type === 'output_text' && typeof x.text === 'string')
                .map((x: any) => x.text)
                .join(''),
            );
        }
        complete = true;
      }
    } else {
      if (type === 'message_start') setUsage(data.message?.usage);
      if (type === 'content_block_delta' && data.delta?.type === 'text_delta')
        append(data.delta.text);
      if (type === 'message_delta') {
        setUsage(data.usage);
        if (data.delta?.stop_reason != null) {
          if (!['end_turn', 'stop_sequence'].includes(data.delta.stop_reason)) throw streamError();
          anthropicStopped = true;
        }
      }
      if (type === 'message_stop') {
        if (!anthropicStopped) throw streamError();
        complete = true;
      }
    }
  };
  const line = (value: string) => {
    if (value === '') {
      dispatch();
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content[0] === ' ') content = content.slice(1);
    if (field === 'data') dataLines.push(content);
    else if (field === 'event') eventName = content;
  };
  const drain = (eof = false) => {
    while (!complete) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      if (!eof && buffer[index] === '\r' && index === buffer.length - 1) break;
      const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      const value = buffer.slice(0, index);
      buffer = buffer.slice(index + length);
      line(value);
    }
  };
  try {
    while (!complete) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        drain(true);
        if (!complete) throw streamError();
        break;
      }
      size += value.length;
      if (size > 2_000_000) throw new AppError('UPSTREAM_STREAM', '模型响应超过大小限制', 502);
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    return text;
  } catch (error) {
    if (error instanceof TypeError && /encoded data/.test(error.message)) throw streamError();
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
