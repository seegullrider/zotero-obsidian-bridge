import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZoteroClient } from '../src/api';
import type { Library, Paper, ZoteroItem } from '../src/types';

const personal: Library = { type: 'user', id: 1234, name: 'My Library' };
const physics: Library = { type: 'group', id: 5678, name: 'Physics' };
const paper = (key = 'PAPER001', library = personal, fields: Record<string, unknown> = {}): ZoteroItem => ({
  key, version: 8, library, data: { key, itemType: 'journalArticle', title: key, citationKey: 'smith2025', ...fields },
} as ZoteroItem);
const selected = (item = paper()): Paper => ({ library: personal, item });
const child = (key: string, itemType: string, parentItem: string, fields: Record<string, unknown> = {}): ZoteroItem => ({
  key, version: 8, library: personal, data: { key, itemType, parentItem, ...fields },
} as ZoteroItem);
type Handler = (url: URL, response: http.ServerResponse, request: http.IncomingMessage) => void;
function json(response: http.ServerResponse, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(200, {
    'Content-Type': 'application/json', 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-A',
    'X-Zotero-Version': '10.0.5', 'Last-Modified-Version': '8',
    ...(Array.isArray(value) ? { 'Total-Results': String(value.length) } : {}), ...headers,
  });
  response.end(JSON.stringify(value));
}
async function fixture(handler: Handler, run: (client: ZoteroClient, url: string) => Promise<void>, timeoutMs = 500): Promise<void> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['zotero-api-version'], '3');
    if (url.pathname === '/api/') {
      json(response, {});
    } else {
      assert.equal(request.headers['zotero-server-id'], 'server-A');
      handler(url, response, request);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  try { await run(new ZoteroClient(base, timeoutMs), base); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('transport accepts only direct HTTP loopback /api endpoints', () => {
  for (const url of ['https://127.0.0.1:23119/api/', 'http://example.com/api/', 'http://127.0.0.1/connector/', 'http://user:pass@127.0.0.1/api/', 'http://127.0.0.1/api/?token=secret']) {
    assert.throws(() => new ZoteroClient(url), /HTTP loopback/);
  }
  assert.doesNotThrow(() => new ZoteroClient('http://localhost:23119/api'));
  assert.doesNotThrow(() => new ZoteroClient('http://[::1]:23119/api/'));
});

test('root validates API version and requires a database server ID', async () => {
  const cases: Array<Record<string, string>> = [{ 'Zotero-API-Version': '4' }, { 'Zotero-Server-ID': '' }];
  for (const headers of cases) {
    const server = http.createServer((_request, response) => json(response, {}, headers));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new ZoteroClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`);
      await assert.rejects(client.root(), /version 3|server ID|identity/i);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('root reports the current instance and each later request carries that identity', async () => {
  await fixture((_url, response) => json(response, []), async client => {
    assert.deepEqual(await client.root(), { apiVersion: '3', serverId: 'server-A', zoteroVersion: '10.0.5' });
    assert.deepEqual(await client.papers(personal), []);
  });
});

test('library discovery uses native library IDs rather than user alias zero', async () => {
  await fixture((url, response) => {
    if (url.pathname === '/api/users/0/items/top') json(response, [paper()], { 'Total-Results': '434' });
    else if (url.pathname === '/api/users/0/groups') json(response, [{ id: physics.id, data: { id: physics.id, name: 'Physics' } }]);
    else assert.fail(`Unexpected route ${url.pathname}`);
  }, async client => assert.deepEqual(await client.libraries(), [personal, physics]));
});

test('empty personal libraries discover actual ID from the alternate metadata link', async () => {
  await fixture((url, response) => json(response, [], url.pathname === '/api/users/0/collections'
    ? { Link: '<https://www.zotero.org/users/1234/collections>; rel="alternate"' } : {}), async client => {
    assert.deepEqual(await client.libraries(), [personal]);
  });
});

test('paper pagination reads all pages and excludes standalone attachments, notes and trash', async () => {
  await fixture((url, response) => {
    if (!url.searchParams.has('start')) {
      const next = new URL(url); next.searchParams.set('start', '2');
      json(response, [paper(), child('ATTACH01', 'attachment', '')], { 'Total-Results': '5', Link: `<${next}>; rel="next"` });
    } else json(response, [paper('PAPER002'), paper('PAPER003', personal, { deleted: 1 }), child('NOTE0001', 'note', '')], { 'Total-Results': '5' });
  }, async client => assert.deepEqual((await client.papers(personal)).map(p => p.item.key), ['PAPER001', 'PAPER002']));
});

test('lists reject missing pages, duplicate keys and totals that change mid-read', async () => {
  await fixture((_url, response) => json(response, [paper()], { 'Total-Results': '2' }), async client => {
    await assert.rejects(client.papers(personal), /next page is missing/);
  });
  await fixture((_url, response) => json(response, [paper(), paper()]), async client => {
    await assert.rejects(client.papers(personal), /duplicate/);
  });
  await fixture((url, response) => {
    if (!url.searchParams.has('start')) {
      const next = new URL(url); next.searchParams.set('start', '1');
      json(response, [paper()], { 'Total-Results': '2', Link: `<${next}>; rel="next"` });
    } else json(response, [paper('PAPER002')], { 'Total-Results': '3' });
  }, async client => await assert.rejects(client.papers(personal), /changed during pagination/));
});

test('lists reject external pagination and pagination changing query or library', async () => {
  for (const next of ['http://example.com/api/users/1234/items/top?format=json&start=1',
    'http://127.0.0.1:PORT/api/groups/5678/items/top?format=json&start=1',
    'http://127.0.0.1:PORT/api/users/1234/items/top?format=keys&start=1']) {
    await fixture((url, response) => json(response, [paper()], {
      'Total-Results': '2', Link: `<${next.replace('PORT', url.port)}>; rel="next"`,
    }), async client => await assert.rejects(client.papers(personal), /outside|changed the requested query/));
  }
});

test('responses from a changed database or changed library version are rejected', async () => {
  await fixture((_url, response) => json(response, [], { 'Zotero-Server-ID': 'server-B' }), async client => {
    await assert.rejects(client.papers(personal), /server changed/);
  });
  await fixture((url, response) => {
    if (!url.searchParams.has('start')) {
      const next = new URL(url); next.searchParams.set('start', '1');
      json(response, [paper()], { 'Total-Results': '2', Link: `<${next}>; rel="next"` });
    } else json(response, [paper('PAPER002')], { 'Total-Results': '2', 'Last-Modified-Version': '9' });
  }, async client => await assert.rejects(client.papers(personal), /library changed/));
});

test('malformed JSON, missing data keys and a foreign library are rejected', async () => {
  await fixture((_url, response) => {
    response.writeHead(200, { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-A', 'Total-Results': '1', 'Last-Modified-Version': '8' });
    response.end('[{"key":');
  }, async client => await assert.rejects(client.papers(personal), /invalid JSON/));
  await fixture((_url, response) => json(response, [{ key: 'PAPER001', data: { itemType: 'journalArticle' } }]), async client => {
    await assert.rejects(client.papers(personal), /invalid Zotero item/);
  });
  await fixture((_url, response) => json(response, [paper('PAPER001', physics)]), async client => {
    await assert.rejects(client.papers(personal), /different library/);
  });
});

test('transport rejects a timed-out connection and a truncated HTTP body', async () => {
  await fixture((_url, _response) => {}, async client => await assert.rejects(client.papers(personal), /timed out/), 30);
  await fixture((_url, response) => {
    response.writeHead(200, { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-A', 'Total-Results': '1', 'Content-Length': '1000' });
    response.write('[{"key":');
    setTimeout(() => response.destroy(), 5);
  }, async client => await assert.rejects(client.papers(personal), /truncated|completely|incomplete/));
});

test('bundle reads notes and every attachment’s annotations under a consistent library version', async () => {
  const attachment = child('ATTACH01', 'attachment', 'PAPER001');
  const note = child('NOTE0001', 'note', 'PAPER001', { note: '<p>notes</p>' });
  const annotation = child('ANNOT001', 'annotation', 'ATTACH01', { annotationText: 'a highlight' });
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) json(response, [paper()]);
    else if (url.pathname.endsWith('/items/PAPER001/children')) json(response, [attachment, note]);
    else if (url.pathname.endsWith('/items/ATTACH01/children')) json(response, url.searchParams.get('itemType') === 'annotation' ? [annotation] : []);
    else assert.fail(url.pathname);
  }, async client => {
    const result = await client.bundle(selected());
    assert.deepEqual(result.attachments, [attachment]);
    assert.deepEqual(result.notes, [note]);
    assert.deepEqual(result.annotations, [annotation]);
  });
});

test('annotation-specific child reads are required even when generic children are empty', async () => {
  const attachment = child('ATTACH01', 'attachment', 'PAPER001');
  const annotation = child('ANNOT001', 'annotation', 'ATTACH01');
  let annotationReads = 0;
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) json(response, [paper()]);
    else if (url.pathname.endsWith('/items/PAPER001/children')) json(response, [attachment]);
    else if (url.searchParams.get('itemType') === 'annotation') { annotationReads++; json(response, [annotation]); }
    else json(response, []);
  }, async client => {
    const bundle = await client.bundle(selected());
    assert.equal(annotationReads, 1);
    assert.deepEqual(bundle.annotations, [annotation]);
  });
});

test('future generic child responses containing annotations do not cause duplicate highlights', async () => {
  const attachment = child('ATTACH01', 'attachment', 'PAPER001');
  const annotation = child('ANNOT001', 'annotation', 'ATTACH01');
  const note = child('NOTE0002', 'note', 'ATTACH01', { note: 'An attachment note' });
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) json(response, [paper()]);
    else if (url.pathname.endsWith('/items/PAPER001/children')) json(response, [attachment]);
    else if (url.searchParams.get('itemType') === 'annotation') json(response, [annotation]);
    else json(response, [note, annotation]);
  }, async client => {
    const bundle = await client.bundle(selected());
    assert.deepEqual(bundle.annotations, [annotation]);
    assert.deepEqual(bundle.notes, [note]);
  });
});

test('failure or wrong parent in an annotation-specific read rejects the entire bundle', async () => {
  for (const failure of ['http', 'parent']) {
    await fixture((url, response) => {
      if (url.pathname.endsWith('/items/top')) json(response, [paper()]);
      else if (url.pathname.endsWith('/items/PAPER001/children')) json(response, [child('ATTACH01', 'attachment', 'PAPER001')]);
      else if (url.searchParams.get('itemType') === 'annotation') {
        if (failure === 'http') { response.writeHead(500); response.end(); }
        else json(response, [child('ANNOT001', 'annotation', 'ATTACH02')]);
      } else json(response, []);
    }, async client => await assert.rejects(client.bundle(selected()), /HTTP 500|invalid annotation/));
  }
});

test('bundle rejects partial child failure, disappearance and annotations with an invalid parent', async () => {
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) json(response, [paper()]);
    else if (url.pathname.endsWith('/items/PAPER001/children')) json(response, [child('ATTACH01', 'attachment', 'PAPER001')]);
    else { response.writeHead(500); response.end(); }
  }, async client => await assert.rejects(client.bundle(selected()), /HTTP 500/));
  await fixture((_url, response) => { response.writeHead(404); response.end(); }, async client => {
    await assert.rejects(client.bundle(selected()), /no longer available/);
  });
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) json(response, [paper()]);
    else json(response, [child('NOTE0001', 'note', 'OTHER001')]);
  }, async client => await assert.rejects(client.bundle(selected()), /unexpected parent/));
});

test('bundle compares library versions even when the paper’s own version is older', async () => {
  const older = { ...paper(), version: 0 };
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) {
      assert.equal(url.searchParams.get('itemKey'), older.key);
      json(response, [older], { 'Last-Modified-Version': '8' });
    } else if (url.pathname.endsWith('/children')) json(response, [], { 'Last-Modified-Version': '8' });
    else assert.fail('Single-object item versions must not be used as library versions.');
  }, async client => {
    assert.equal((await client.bundle(selected(older))).item.version, 0);
  });
});

test('bundle preserves notes if the library changes during the final consistency check', async () => {
  let reads = 0;
  await fixture((url, response) => {
    if (url.pathname.endsWith('/items/top')) json(response, [paper()], { 'Last-Modified-Version': ++reads === 1 ? '8' : '9' });
    else json(response, []);
  }, async client => await assert.rejects(client.bundle(selected()), /library changed/));
});

test('collections preserve group identity and selected collection papers exclude attachment records', async () => {
  await fixture((url, response) => {
    if (url.pathname === '/api/groups/5678/collections') json(response, [{ key: 'COLLECT1', library: physics, data: { name: 'Methods', parentCollection: false } }]);
    else if (url.pathname === '/api/groups/5678/collections/COLLECT1/items/top') json(response, [paper('PAPER001', physics), { ...child('ATTACH01', 'attachment', ''), library: physics }]);
    else assert.fail(url.pathname);
  }, async client => {
    assert.equal((await client.collections(physics))[0].data.name, 'Methods');
    const papers = await client.collectionPapers(physics, 'COLLECT1');
    assert.equal(papers.length, 1);
    assert.deepEqual(papers[0].library, physics);
  });
});

test('IEEE requests retrieve only the selected item with the already installed IEEE style', async () => {
  const bib = '<div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">A. Author, “Title.”</div></div>';
  await fixture((url, response) => {
    assert.equal(url.pathname, '/api/users/1234/items/PAPER001');
    assert.equal(url.searchParams.get('style'), 'ieee');
    assert.equal(url.searchParams.get('include'), 'data,bib');
    json(response, { ...paper(), bib });
  }, async client => assert.equal(await client.reference(selected()), bib));
});

test('lookup returns a native record or null only for a genuine same-server 404', async () => {
  await fixture((url, response) => {
    assert.equal(url.pathname, '/api/users/1234/items/PAPER001');
    json(response, paper());
  }, async client => assert.deepEqual(await client.lookup(personal, 'PAPER001'), paper()));
  await fixture((_url, response) => {
    response.writeHead(404, { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-A' }); response.end();
  }, async client => assert.equal(await client.lookup(personal, 'UNKNOWN1'), null));
});

test('lookup never reports HTTP 500, wrong-server 404 or invalid JSON as a missing item', async () => {
  await fixture((_url, response) => { response.writeHead(500); response.end(); }, async client => {
    await assert.rejects(client.lookup(personal, 'PAPER001'), /HTTP 500/);
  });
  await fixture((_url, response) => {
    response.writeHead(404, { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-B' }); response.end();
  }, async client => await assert.rejects(client.lookup(personal, 'PAPER001'), /server changed/));
  await fixture((_url, response) => {
    response.writeHead(200, { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'server-A' }); response.end('{');
  }, async client => await assert.rejects(client.lookup(personal, 'PAPER001'), /invalid JSON/));
});
