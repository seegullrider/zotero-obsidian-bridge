import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, paperLink, pdfAnnotationLink, renderManaged, zoteroItemLink } from '../src/render';
import { wrapManaged, parseManaged } from '../src/managed';
import type { Asset, PaperBundle, ZoteroItem } from '../src/types';

const annotation = (key: string, page?: number, data = {}): ZoteroItem => ({key, data: {
  itemType: 'annotation', parentItem: 'PDFABCDE', annotationType: 'highlight',
  annotationPosition: JSON.stringify(page === undefined ? {} : {pageIndex: page}),
  annotationPageLabel: page === undefined ? 'iv' : String(page + 1),
  annotationText: `Text ${key}`, annotationColor: '#ffd400', ...data,
}});
const bundle: PaperBundle = {library: {type: 'user', id: 123, name: 'My Library'},
  item: {key: 'ABCDEFGH', data: {itemType: 'journalArticle', title: 'A paper', citationKey: 'paper2026',
    creators: [{firstName: 'Ada', lastName: 'Lovelace'}], date: '2026', DOI: '10.1000/test', url: 'https://example.org/paper'}},
  attachments: [{key: 'PDFABCDE', data: {itemType: 'attachment', contentType: 'application/pdf', title: 'Full text'}}],
  notes: [{key: 'NOTEABCD', data: {itemType: 'note', note: '<p>A useful <strong>note</strong>.</p>'}}], annotations: [],
};

test('personal and group links use distinct deep links and actual note paths', () => {
  assert.equal(zoteroItemLink(bundle), 'zotero://select/library/items/ABCDEFGH');
  const group = {...bundle, library: {type: 'group' as const, id: 456, name: 'Physics'}};
  assert.equal(zoteroItemLink(group), 'zotero://select/groups/456/items/ABCDEFGH');
  assert.equal(paperLink(bundle, 'physics/note/My existing title.md'), '[[physics/note/My existing title|A paper]]');
  assert.equal(paperLink(bundle), '[A paper](zotero://select/library/items/ABCDEFGH)');
  assert.equal(paperLink(bundle, 'physics/note/Paper #1.md'), '[A paper](physics/note/Paper%20%231.md)');
});

test('PDF links use physical indices rather than Roman display labels', () => {
  const known = annotation('ANNOTATE', 4, {annotationPageLabel: 'iv'});
  assert.equal(pdfAnnotationLink(bundle.library, 'PDFABCDE', known), 'zotero://open-pdf/library/items/PDFABCDE?page=5&annotation=ANNOTATE');
  const unknown = annotation('ANNOTATE', undefined, {annotationPageLabel: 'iv'});
  const link = pdfAnnotationLink(bundle.library, 'PDFABCDE', unknown);
  assert.equal(link, 'zotero://open-pdf/library/items/PDFABCDE?annotation=ANNOTATE');
  assert.ok(!link.includes('page='));
  assert.equal(pdfAnnotationLink({type: 'group', id: 456, name: 'Physics'}, 'PDFABCDE', known), 'zotero://open-pdf/groups/456/items/PDFABCDE?page=5&annotation=ANNOTATE');
});

test('annotations are deterministic, sorted by physical page, and retain colors/tags/comments', () => {
  const first = annotation('ANNFIRST', 0, {annotationComment: 'A question', tags: [{tag: 'methods'}, {tag: 'AI'}]});
  const last = annotation('ANNLASTX', 9);
  const rendered = renderManaged({...bundle, annotations: [last, first]}, []);
  assert.ok(rendered.indexOf('^zotero-ANNFIRST') < rendered.indexOf('^zotero-ANNLASTX'));
  assert.ok(rendered.includes('Yellow \\(\\#ffd400\\)'));
  assert.match(rendered, /\*\*Comment:\*\* A question/);
  assert.match(rendered, /\*\*Tags:\*\* AI, methods/);
  assert.equal(rendered, renderManaged({...bundle, annotations: [first, last]}, []));
  const removed = renderManaged({...bundle, annotations: [first]}, []);
  assert.ok(!removed.includes('ANNLASTX'));
});

test('available image and ink assets embed vault files; missing images remain explicit', () => {
  const image = annotation('IMAGEABC', 1, {annotationType: 'image', annotationComment: 'My comment'});
  const ink = annotation('INKABCDE', 2, {annotationType: 'ink'});
  const missing = annotation('MISSINGX', 3, {annotationType: 'image'});
  const assets: Asset[] = [{annotationKey: 'IMAGEABC', status: 'available', path: 'attachments/zotero-bridge/user-123/IMAGEABC.png'},
    {annotationKey: 'INKABCDE', status: 'available', path: 'attachments/zotero-bridge/user-123/INKABCDE.png'},
    {annotationKey: 'MISSINGX', status: 'missing', path: '', reason: 'Cache missing.'}];
  const rendered = renderManaged({...bundle, annotations: [image, ink, missing]}, assets);
  assert.match(rendered, /!\[\[attachments\/zotero-bridge\/user-123\/IMAGEABC.png\]\]/);
  assert.match(rendered, /!\[\[attachments\/zotero-bridge\/user-123\/INKABCDE.png\]\]/);
  assert.match(rendered, /Visual unavailable for MISSINGX/);
  assert.match(rendered, /My comment/);
  assert.ok(!rendered.includes('![[' + assets[0].path + '.pdf]]'));
  assert.match(renderManaged({...bundle, annotations: [image]}, [{...assets[0], path: '../outside.png'}]), /Visual unavailable/);
});

test('HTML conversion preserves basic notes and strips executable or remote embedding content', () => {
  const rendered = htmlToMarkdown('<p>One <strong>important</strong> &amp; <em>useful</em> result.</p>' +
    '<script>alert("secret")</script><style>.bad{}</style><iframe src="https://evil.test"></iframe>' +
    '<a href="javascript:alert(1)">Unsafe link</a> <a href="https://example.org/paper">Paper</a>' +
    '<img src="https://evil.test/pixel.png" alt="plot"><p>&lt;script&gt;encoded&lt;/script&gt;</p>');
  assert.match(rendered, /One \*\*important\*\* & \*useful\* result\./);
  assert.ok(!rendered.includes('secret') && !rendered.includes('evil.test') && !rendered.includes('javascript:'));
  assert.match(rendered, /\[Paper\]\(https:\/\/example.org\/paper\)/);
  assert.match(rendered, /\[Image: plot\]/);
  assert.ok(!rendered.includes('<script>'));
  assert.match(rendered, /&lt;script&gt;/);
});

test('incoming annotations cannot inject managed markers, HTML, or block IDs', () => {
  const hostile = annotation('ANNOTATE', 0, {annotationText: '<!-- zotero-bridge:end -->\n^zotero-FAKEKEYX\n<img src="https://evil.test/x">\n![pixel](https://evil.test/x)',
    annotationComment: '<!-- zotero-bridge:start {} -->\n^zotero-FAKEKEYX'});
  const content = renderManaged({...bundle, annotations: [hostile]}, []);
  assert.ok(!content.includes('<!-- zotero-bridge:'));
  assert.ok(!content.includes('\n^zotero-FAKEKEYX'));
  assert.ok(!content.includes('<img'));
  assert.equal((content.match(/^\^zotero-/gm) ?? []).length, 1);
  const wrapped = wrapManaged({type: 'user', id: 123, key: 'ABCDEFGH'}, content);
  assert.equal(parseManaged(wrapped)!.content, content);
});

test('metadata/newlines and unexpected schemes cannot inject HTML or source links', () => {
  const rendered = renderManaged({...bundle, item: {...bundle.item, data: {...bundle.item.data,
    title: 'Line one\n## fake heading <img src=x>', url: 'javascript:alert(1)'}}}, []);
  assert.ok(!rendered.includes('\n## fake heading'));
  assert.ok(!rendered.includes('javascript:'));
  assert.ok(!rendered.includes('<img'));
});
