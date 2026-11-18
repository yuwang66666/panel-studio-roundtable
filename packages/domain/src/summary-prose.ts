const MAX_ENCODED_LENGTH = 64_000;
const MAX_WRAPPERS = 6;
const JSON_SCALAR = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u;
const JSON_KEY = /"(?:[^"\\\r\n]|\\.)*"\s*:/u;

function trimText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').trim();
}

function plainProse(text: string): string | null {
  const value = trimText(text);
  // Summaries must paraphrase structures rather than expose serialized fragments.
  if (
    !value ||
    value.length > MAX_ENCODED_LENGTH ||
    !/\p{L}/u.test(value) ||
    /[{}\[\]]|```|~~~/u.test(value) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    JSON_KEY.test(value) ||
    JSON_SCALAR.test(value)
  )
    return null;
  return value;
}

function unwrap(value: unknown, depth: number): string | null {
  if (depth > MAX_WRAPPERS) return null;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || !['content', 'summary'].includes(keys[0])) return null;
    return unwrap((value as Record<string, unknown>)[keys[0]], depth + 1);
  }
  if (typeof value !== 'string' || value.length > MAX_ENCODED_LENGTH) return null;
  const text = trimText(value);
  if (!text) return null;
  if (/^(?:```|~~~)/u.test(text)) {
    const fence = text.match(/^(```|~~~)(?:json)?[ \t]*\n([\s\S]*?)\n\1$/iu);
    return fence ? unwrap(fence[2], depth + 1) : null;
  }
  if (/^[{"\[]/u.test(text) || JSON_SCALAR.test(text)) {
    try {
      return unwrap(JSON.parse(text), depth + 1);
    } catch {
      // An English quotation can start prose, but a serialized object/key cannot.
      if (!text.startsWith('"')) return null;
      let closed = -1;
      for (let i = 1; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') {
          closed = i;
          break;
        }
      }
      return closed > 0 && text.slice(closed + 1).trim() ? plainProse(text) : null;
    }
  }
  return plainProse(text);
}

/** Return only readable prose from a bounded set of public summary wrappers. */
export function extractSummaryProse(text: string): string | null {
  return unwrap(text, 0);
}

/**
 * Project an accumulated, unfinished summary without ever publishing JSON syntax.
 * Ambiguous prefixes remain buffered; final acceptance uses extractSummaryProse.
 */
export function projectSummaryProse(text: string): string {
  if (text.length > MAX_ENCODED_LENGTH) return '';
  const value = text.replace(/\r\n?/gu, '\n').trimStart();
  if (!value) return '';
  // A closed JSON string can still become a bare object key in a later fragment.
  // Wait for final validation before displaying any quote-prefixed serialization.
  if (value.startsWith('"')) return '';
  if (/^[{\[`~]/u.test(value)) return extractSummaryProse(value) || '';
  if (['true', 'false', 'null'].some((literal) => literal.startsWith(value.trimEnd()))) return '';
  if (/^-?(?:\d*(?:\.\d*)?)(?:[eE][+-]?\d*)?$/u.test(value.trimEnd())) return '';

  // A future fragment can turn an ASCII quote into a JSON key or a backtick into
  // a fence. Retain only the already-unambiguous prefix until final validation.
  const boundary = value.search(/[{}\[\]"`~]/u);
  return plainProse(boundary < 0 ? value : value.slice(0, boundary)) || '';
}
