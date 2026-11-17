import test from 'node:test';
import assert from 'node:assert/strict';
import { graphemes, normalizeText, planTyping, keyEventParams } from '../extension/typing.js';

test('graphemes keeps user-visible characters intact', () => {
  const characters = graphemes('A你👍🏽👨‍👩‍👧‍👦é');
  assert.deepEqual(characters, ['A', '你', '👍🏽', '👨‍👩‍👧‍👦', 'é']);
});

test('printable ASCII characters use physical key events', () => {
  const plan = planTyping('aA! 1');
  assert.equal(plan.characters, 5);
  assert.deepEqual(plan.segments.map(segment => segment.kind), ['key', 'key', 'key', 'key', 'key']);
  const [lowerA, upperA, bang, space, one] = plan.segments;
  assert.equal(lowerA.code, 'KeyA');
  assert.equal(lowerA.keyCode, 65);
  assert.equal(lowerA.modifiers, 0);
  assert.equal(upperA.code, 'KeyA');
  assert.equal(upperA.modifiers, 8);
  assert.equal(bang.code, 'Digit1');
  assert.equal(bang.keyCode, 49);
  assert.equal(bang.modifiers, 8);
  assert.equal(space.code, 'Space');
  assert.equal(space.key, ' ');
  assert.equal(one.code, 'Digit1');
  assert.equal(plan.insertedText, 'aA! 1');
});

test('punctuation uses a US-layout key map and never an Enter key', () => {
  const plan = planTyping('()_+{}|:"<>?~`-=\\/,.;\'[]');
  assert.ok(plan.segments.every(segment => segment.kind === 'key'));
  assert.ok(plan.segments.every(segment => segment.key !== 'Enter'));
  const newlinePlan = planTyping('\n');
  assert.equal(newlinePlan.segments.length, 0);
  assert.equal(newlinePlan.skippedCharacters, 1);
  assert.ok(!newlinePlan.segments.some(segment => segment.key === 'Enter'));
});

test('single-line controls skip newlines without pressing Enter', () => {
  const plan = planTyping('第一行\r\n第二行\n', { multiline: false });
  assert.equal(plan.characters, 8);
  assert.equal(plan.skippedCharacters, 2);
  assert.equal(plan.insertedText, '第一行第二行');
  assert.equal(plan.segments.filter(segment => segment.text === '\n').length, 0);
});

test('textarea/contenteditable receive newlines through the text path', () => {
  const plan = planTyping('a\nb', { multiline: true });
  assert.deepEqual(plan.segments.map(segment => segment.kind), ['key', 'text', 'key']);
  assert.equal(plan.segments[1].text, '\n');
  assert.equal(plan.skippedCharacters, 0);
  assert.equal(plan.insertedText, 'a\nb');
});

test('CJK, emoji and other layouts are submitted as text segments per grapheme', () => {
  const plan = planTyping('中文👨‍👩‍👧‍👦，');
  assert.deepEqual(plan.segments.map(segment => segment.kind), ['text', 'text', 'text', 'text']);
  assert.deepEqual(plan.segments.map(segment => segment.text), ['中', '文', '👨‍👩‍👧‍👦', '，']);
  assert.equal(plan.characters, 4);
  assert.equal(plan.insertedText, '中文👨‍👩‍👧‍👦，');
});

test('CRLF and lone CR normalize to a single newline', () => {
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc');
  const plan = planTyping('a\r\nb', { multiline: true });
  assert.equal(plan.characters, 3);
  assert.equal(plan.segments[1].text, '\n');
});

test('key event parameters separate raw keydown from character insertion', () => {
  const [segment] = planTyping('!').segments;
  const down = keyEventParams(segment, 'rawKeyDown');
  const character = keyEventParams(segment, 'char');
  const up = keyEventParams(segment, 'keyUp');
  assert.equal(down.type, 'rawKeyDown');
  assert.equal('text' in down, false);
  assert.equal(character.type, 'char');
  assert.equal(character.text, '!');
  assert.equal(character.unmodifiedText, '!');
  assert.equal(character.modifiers, 8);
  assert.equal(up.type, 'keyUp');
  assert.equal(up.key, '!');
});
