// Opaque identifiers: a three-letter kind, an underscore and 22 base62
// characters (about 131 bits). They work in the browser and in Node. Ids are
// handles, not credentials: every route that takes one also checks a token.

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// 248 = 62 * 4 is the largest multiple of 62 that fits in a byte. Bytes at or
// above it are discarded so every character is equally likely.
const LIMIT = 248;

export type IdKind = "ses" | "pho" | "img" | "cal" | "try";

function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= LIMIT) continue;
      out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function newId(kind: IdKind): string {
  return `${kind}_${randomBase62(22)}`;
}

const ID = /^(ses|pho|img|cal|try)_[A-Za-z0-9]{22}$/;

export function isId(value: unknown, kind?: IdKind): value is string {
  if (typeof value !== "string" || !ID.test(value)) return false;
  return kind ? value.startsWith(`${kind}_`) : true;
}
