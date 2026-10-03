import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManaged, planUpdate, wrapManaged } from '../src/managed';
import type { Paper } from '../src/types';

const paper: Paper = {library: {type: 'user', id: 123, name: 'My Library'}, item: {key: 'ABCDEFGH', data: {itemType: 'journalArticle', title: 'Test: "quoted" paper', citationKey: 'test2026'}}};

test('migration preserves the complete legacy body including handwritten annotations', () => {
  const legacy = '\uFEFF---\r\ntitle: My paper\r\n---\r\n\r\n> Imported highlight\r\nMy handwritten reaction: useful for MBE.\r\n';
  const result = planUpdate(legacy, paper, '## Current Zotero data\n\nNew annotation');
  assert.ok(result.text.startsWith(legacy));
  const block = parseManaged(result.text)!;
  assert.deepEqual(block.identity, {type: 'user', id: 123, key: 'ABCDEFGH'});
  assert.equal(block.content, '## Current Zotero data\n\nNew annotation');
});

test('repeat import is an exact no-op', () => {
  const initial = planUpdate(null, paper, 'Original generated content').text;
  assert.deepEqual(planUpdate(initial, paper, 'Original generated content'), {text: initial, changed: false});
});

test('refresh replaces only the section and preserves later personal writing', () => {
  const block = wrapManaged({type: 'user', id: 123, key: 'ABCDEFGH'}, 'Old annotation\n^zotero-ANNOTATE');
  const before = '---\r\ncustom: value\r\n---\r\n\r\nPersonal before\n';
  const after = '\r\n\r\n## Further thoughts\r\nPersonal after including ^custom-id.\r\n';
  const result = planUpdate(before + block + after, paper, 'Replacement annotation');
  assert.equal(result.text.slice(0, before.length), before);
  assert.ok(result.text.endsWith(after));
  assert.equal(parseManaged(result.text)!.content, 'Replacement annotation');
  assert.ok(!result.text.includes('Old annotation'));
});

test('manually edited generated section is refused', () => {
  const initial = planUpdate(null, paper, 'Generated original').text;
  assert.throws(() => planUpdate(initial.replace('Generated original', 'My edit'), paper, 'New generation'), /was edited/);
});

test('identity tampering and wrong connected paper are refused', () => {
  const initial = planUpdate(null, paper, 'Content').text;
  assert.throws(() => parseManaged(initial.replace('"id":123', '"id":456')), /was edited/);
  const groupPaper: Paper = {...paper, library: {type: 'group', id: 123, name: 'Physics'}};
  assert.throws(() => planUpdate(initial, groupPaper, 'Content'), /different Zotero paper/);
});

test('malformed, incomplete, nested, and repeated blocks are refused', () => {
  assert.equal(parseManaged('Plain legacy note without a connection'), null);
  const good = wrapManaged({type: 'user', id: 123, key: 'ABCDEFGH'}, 'Content');
  for (const malformed of [good.replace('"version":1', '"version":2'), good.replace('"sha256":', '"missingHash":'), good.replace('<!-- zotero-bridge:end -->', ''), good + '\n' + good, '<!-- zotero-bridge:end -->\n' + good]) {
    assert.throws(() => parseManaged(malformed));
  }
  assert.throws(() => wrapManaged({type: 'user', id: 123, key: 'ABCDEFGH'}, '<!-- zotero-bridge:end -->'), /reserved/);
});

test('new notes quote YAML metadata and include independent personal headings', () => {
  const result = planUpdate(null, paper, 'Generated content').text;
  assert.match(result, /title: "Test: \\"quoted\\" paper"/);
  assert.match(result, /zotero_item_key: "ABCDEFGH"/);
  assert.match(result, /## 总结 \/ Summary/);
  assert.match(result, /## 问题 \/ Questions/);
  assert.equal(parseManaged(result)!.content, 'Generated content');
});
