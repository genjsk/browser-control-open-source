// Pure typing planner shared by the MV3 service worker and Node tests.
// It converts user-visible characters into CDP input segments. ASCII characters
// that exist on a US keyboard use real key events (keydown/keypress/keyup);
// everything else (CJK, emoji, other layouts) uses Input.insertText, Chrome's
// text/IME input path. No DOM or Chrome APIs are used here.
const KEY_MAP = {};
function addKey(character, code, keyCode, modifiers = 0, key = character) {
  KEY_MAP[character] = { key, code, keyCode, modifiers };
}
for (let index = 0; index < 26; index++) {
  const lower = String.fromCharCode(97 + index);
  const upper = lower.toUpperCase();
  addKey(lower, `Key${upper}`, 65 + index);
  addKey(upper, `Key${upper}`, 65 + index, 8, upper);
}
for (let digit = 0; digit <= 9; digit++) {
  const character = String(digit);
  const keyCode = digit === 0 ? 48 : 48 + digit;
  addKey(character, `Digit${digit}`, keyCode);
}
const shiftedDigits = { '!': 1, '@': 2, '#': 3, '$': 4, '%': 5, '^': 6, '&': 7, '*': 8, '(': 9, ')': 0 };
for (const [character, digit] of Object.entries(shiftedDigits)) addKey(character, `Digit${digit}`, digit === 0 ? 48 : 48 + digit, 8);
addKey(' ', 'Space', 32, 0, ' ');
for (const [plain, shifted, code, keyCode] of [
  ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221],
  ['\\', '|', 'Backslash', 220], [';', ':', 'Semicolon', 186],
  ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191], ['`', '~', 'Backquote', 192]
]) {
  addKey(plain, code, keyCode);
  addKey(shifted, code, keyCode, 8);
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

export function graphemes(text) {
  if (segmenter) return [...segmenter.segment(text)].map(part => part.segment);
  return [...text];
}

export function normalizeText(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

// Each segment represents one user-visible character. `kind: 'text'` segments
// are sent with Input.insertText, which also covers newlines in multiline
// controls without pressing Enter (Enter could submit a form).
export function planTyping(text, { multiline = false } = {}) {
  const normalized = normalizeText(text);
  const characters = graphemes(normalized);
  const segments = [];
  let skippedCharacters = 0;
  for (const character of characters) {
    if (character === '\n') {
      if (multiline) segments.push({ kind: 'text', text: '\n' });
      else skippedCharacters++;
      continue;
    }
    if (character === '\t' || character === '\u00a0') {
      segments.push({ kind: 'text', text: character });
      continue;
    }
    const mapped = KEY_MAP[character];
    if (mapped) segments.push({ kind: 'key', text: character, ...mapped });
    else segments.push({ kind: 'text', text: character });
  }
  return {
    segments,
    characters: characters.length,
    skippedCharacters,
    insertedText: segments.map(segment => segment.text).join('')
  };
}

// CDP Input.dispatchKeyEvent parameters for one mapped character. The raw
// keydown carries no text so it does not insert anything itself; the explicit
// char event inserts exactly one character and produces the keypress event.
export function keyEventParams(segment, type) {
  const base = {
    key: segment.key,
    code: segment.code,
    windowsVirtualKeyCode: segment.keyCode,
    nativeVirtualKeyCode: segment.keyCode,
    modifiers: segment.modifiers
  };
  if (type === 'char') return { ...base, type, text: segment.text, unmodifiedText: segment.text };
  return { ...base, type };
}
