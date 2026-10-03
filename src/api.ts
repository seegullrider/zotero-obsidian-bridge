import * as http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { Collection, Library, Paper, PaperBundle, RootInfo, ZoteroItem } from './types';

type Response = { body: string; headers: IncomingHttpHeaders; url: URL; status: number };
type RequestOptions = { discovery?: boolean; expectedVersion?: string; allowNotFound?: boolean };
type RawLibrary = { type?: unknown; id?: unknown; name?: unknown };
const NON_PAPERS = new Set(['attachment', 'note', 'annotation']);
const KEY = /^[A-Z0-9]{8}$/;

/** Read-only, direct loopback transport. Never forwards a request through a proxy. */
export class ZoteroClient {
  private readonly base: URL;
  private serverId = '';
  private info?: RootInfo;

  constructor(baseUrl = 'http://127.0.0.1:23119/api/', private readonly timeoutMs = 15000) {
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.search || base.hash
      || !['/api', '/api/'].includes(base.pathname)) {
      throw new Error('Zotero Bridge only accepts an HTTP loopback /api/ endpoint.');
    }
    // Resolve localhost ourselves so the connection never depends on DNS or proxy settings.
    if (base.hostname === 'localhost') base.hostname = '127.0.0.1';
    base.pathname = '/api/';
    this.base = base;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Zotero timeout.');
  }

  /** Explicitly reconnect: the caller can discard caches if this returns a new server ID. */
  async root(): Promise<RootInfo> {
    const result = await this.request(this.base, { discovery: true });
    const apiVersion = header(result.headers, 'zotero-api-version');
    if (apiVersion !== '3') throw new Error(`Unsupported Zotero API version ${apiVersion || '(missing)'}. Version 3 is required.`);
    const serverId = header(result.headers, 'zotero-server-id');
    if (!serverId) throw new Error('Zotero did not provide a server ID. Zotero 10 or newer is required.');
    const info = { apiVersion, serverId, zoteroVersion: header(result.headers, 'x-zotero-version') };
    this.serverId = serverId;
    this.info = info;
    return info;
  }

  async libraries(): Promise<Library[]> {
    await this.ready();
    // /users/0 is not a metadata route in the local API. Objects carry the actual user ID.
    let probe = await this.request(this.url('users/0/items/top', { format: 'json', limit: '1' }));
    let objects = this.jsonArray(probe);
    if (!objects.length) {
      probe = await this.request(this.url('users/0/collections', { format: 'json', limit: '1' }));
      objects = this.jsonArray(probe);
    }
    const metadata = objects.length ? (objects[0] as { library?: RawLibrary }).library : undefined;
    const alternateId = header(probe.headers, 'link').match(/https:\/\/www\.zotero\.org\/users\/(\d+)(?:\/|>)/)?.[1];
    const userId = metadata?.type === 'user' && positiveId(metadata.id) ? Number(metadata.id)
      : alternateId && positiveId(Number(alternateId)) ? Number(alternateId) : undefined;
    if (userId === undefined) {
      throw new Error('Cannot establish the personal library’s stable user ID. Sign in to Zotero before connecting this library.');
    }
    const personal: Library = { type: 'user', id: userId, name: typeof metadata?.name === 'string' ? metadata.name : 'My Library' };
    const groups = await this.list(this.url('users/0/groups', { format: 'json', limit: '100' }));
    const libraries: Library[] = [personal];
    const seen = new Set<number>();
    for (const raw of groups) {
      const group = raw as { id?: unknown; data?: { id?: unknown; name?: unknown } };
      if (!positiveId(group.id) || !group.data || group.data.id !== group.id || typeof group.data.name !== 'string' || seen.has(Number(group.id))) {
        throw new Error('Incomplete or invalid Zotero group metadata.');
      }
      seen.add(Number(group.id));
      libraries.push({ type: 'group', id: Number(group.id), name: group.data.name });
    }
    return libraries;
  }

  async papers(library: Library): Promise<Paper[]> {
    await this.ready();
    const rows = await this.items(this.url(`${prefix(library)}/items/top`, { format: 'json', limit: '100' }), library);
    return rows.filter(isPaper).map(item => ({ library, item }));
  }

  async collections(library: Library): Promise<Collection[]> {
    await this.ready();
    const rows = await this.list(this.url(`${prefix(library)}/collections`, { format: 'json', limit: '100' }));
    return rows.map(raw => {
      const collection = raw as Collection;
      if (!KEY.test(collection?.key) || !collection.data || typeof collection.data.name !== 'string') {
        throw new Error('Incomplete Zotero collection response.');
      }
      checkLibrary(raw, library);
      return collection;
    });
  }

  async collectionPapers(library: Library, key: string): Promise<Paper[]> {
    await this.ready();
    validKey(key);
    const rows = await this.items(this.url(`${prefix(library)}/collections/${key}/items/top`, { format: 'json', limit: '100' }), library);
    return rows.filter(isPaper).map(item => ({ library, item }));
  }

  /** Audit a native key without confusing a transport/server error with a missing record. */
  async lookup(library: Library, key: string): Promise<ZoteroItem | null> {
    await this.ready();
    validKey(key);
    const response = await this.request(this.url(`${prefix(library)}/items/${key}`, { format: 'json' }), { allowNotFound: true });
    if (response.status === 404) return null;
    const item = this.item(this.json(response), library);
    if (item.key !== key) throw new Error('Zotero returned a different item than requested.');
    return item;
  }

  async bundle(paper: Paper): Promise<PaperBundle> {
    await this.ready();
    validKey(paper.item.key);
    const path = `${prefix(paper.library)}/items/${paper.item.key}`;
    // Single-object Last-Modified-Version is an ITEM version. Use a key-filtered multi-object
    // request so this stamp represents the LIBRARY and can safely be compared with children.
    const { item: current, version } = await this.selectedItem(paper);
    const children = await this.items(this.url(`${path}/children`, { format: 'json', limit: '100' }), paper.library, version);
    const attachments = children.filter(item => !deleted(item) && item.data.itemType === 'attachment');
    const notes = children.filter(item => !deleted(item) && item.data.itemType === 'note');
    const annotations = children.filter(item => !deleted(item) && item.data.itemType === 'annotation');
    for (const child of children) if (child.data.parentItem !== current.key) throw new Error('A Zotero child has an unexpected parent; refresh was cancelled.');
    // Fetch every attachment's children. A failed read rejects the whole bundle, never a partial refresh.
    for (const attachment of attachments) {
      const nested = await this.items(this.url(`${prefix(paper.library)}/items/${attachment.key}/children`, { format: 'json', limit: '100' }), paper.library, version);
      for (const child of nested) {
        if (child.data.parentItem !== attachment.key) throw new Error('A Zotero annotation has an unexpected attachment; refresh was cancelled.');
        if (deleted(child)) continue;
        if (child.data.itemType === 'note') notes.push(child);
      }
      // Zotero 10's unfiltered children search omits annotations. The documented itemType
      // filter selects the annotation search level, so request it explicitly instead of
      // treating an empty generic child list as proof that this PDF has no annotations.
      const highlights = await this.items(this.url(`${prefix(paper.library)}/items/${attachment.key}/children`, {
        format: 'json', limit: '100', itemType: 'annotation',
      }), paper.library, version);
      for (const highlight of highlights) {
        if (highlight.data.itemType !== 'annotation' || highlight.data.parentItem !== attachment.key) {
          throw new Error('Zotero returned an invalid annotation selection; refresh was cancelled.');
        }
        if (!deleted(highlight)) annotations.push(highlight);
      }
    }
    rejectDuplicates([...attachments, ...notes, ...annotations]);
    // Check the library once more before returning; edits during the final fetch must not produce stale output.
    const { item: final } = await this.selectedItem(paper, version);
    if (final.key !== current.key || JSON.stringify(final.data) !== JSON.stringify(current.data)) {
      throw new Error('The Zotero paper changed while it was being read. Refresh again; existing notes were preserved.');
    }
    return { library: paper.library, item: current, attachments, notes, annotations };
  }

  /** Return an individual IEEE reference in HTML; the UI converts HTML and removes isolated numbering. */
  async reference(paper: Paper): Promise<string> {
    await this.ready();
    validKey(paper.item.key);
    const response = await this.request(this.url(`${prefix(paper.library)}/items/${paper.item.key}`, {
      format: 'json', include: 'data,bib', style: 'ieee', locale: 'en-US', linkwrap: '1',
    }));
    const current = this.item(this.json(response), paper.library);
    if (current.key !== paper.item.key || !isPaper(current) || typeof current.bib !== 'string' || !current.bib.trim()) {
      throw new Error('Zotero could not provide an IEEE reference for this paper.');
    }
    return current.bib;
  }

  private async ready(): Promise<void> { if (!this.info) await this.root(); }

  private url(path: string, params: Record<string, string> = {}): URL {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  private async items(url: URL, library: Library, version?: string): Promise<ZoteroItem[]> {
    return (await this.list(url, version)).map(raw => this.item(raw, library));
  }

  private async selectedItem(paper: Paper, expectedVersion?: string): Promise<{item: ZoteroItem; version: string}> {
    const response = await this.request(this.url(`${prefix(paper.library)}/items/top`, {
      format: 'json', itemKey: paper.item.key, limit: '100',
    }), { expectedVersion });
    const rows = this.jsonArray(response);
    const total = header(response.headers, 'total-results');
    if (!rows.length && total === '0') throw new Error('The selected paper no longer exists in Zotero. Existing notes were preserved.');
    if (rows.length !== 1 || total !== '1' || nextLink(header(response.headers, 'link'))) {
      throw new Error('Incomplete Zotero response for the selected paper. Existing notes were preserved.');
    }
    const item = this.item(rows[0], paper.library);
    if (item.key !== paper.item.key || !isPaper(item)) throw new Error('The selected paper no longer exists in Zotero. Existing notes were preserved.');
    const version = header(response.headers, 'last-modified-version');
    if (!/^\d+$/.test(version)) throw new Error('Incomplete Zotero response: the library version is missing.');
    return { item, version };
  }

  private item(raw: unknown, library: Library): ZoteroItem {
    const item = raw as ZoteroItem;
    if (!item || !KEY.test(item.key) || !item.data || item.data.key !== item.key || typeof item.data.itemType !== 'string') {
      throw new Error('Incomplete or invalid Zotero item response.');
    }
    checkLibrary(raw, library);
    return item;
  }

  private json(response: Response): unknown {
    try { return JSON.parse(response.body); }
    catch { throw new Error('Incomplete or invalid JSON received from Zotero. Existing notes were preserved.'); }
  }

  private jsonArray(response: Response): unknown[] {
    const data = this.json(response);
    if (!Array.isArray(data)) throw new Error('Incomplete Zotero response: expected an object list.');
    return data;
  }

  private async list(initial: URL, expectedVersion?: string): Promise<unknown[]> {
    let url: URL | undefined = initial;
    let total: number | undefined;
    let version = expectedVersion;
    const result: unknown[] = [];
    const visited = new Set<string>();
    while (url) {
      if (visited.has(url.href)) throw new Error('Incomplete Zotero pagination: repeated page.');
      visited.add(url.href);
      const response = await this.request(url, { expectedVersion: version });
      const currentVersion = header(response.headers, 'last-modified-version');
      if (!currentVersion && !/\/users\/\d+\/groups$/.test(initial.pathname)) {
        throw new Error('Incomplete Zotero response: the library version is missing.');
      }
      if (currentVersion && !version) version = currentVersion;
      const totalHeader = header(response.headers, 'total-results');
      if (!/^\d+$/.test(totalHeader) || Number(totalHeader) > 1000000) throw new Error('Incomplete Zotero response: invalid Total-Results.');
      const count = Number(totalHeader);
      if (total !== undefined && count !== total) throw new Error('Zotero changed during pagination. Refresh again.');
      total = count;
      const data = this.jsonArray(response);
      if (!data.length && result.length < total) throw new Error('Incomplete Zotero response: an expected page is empty.');
      result.push(...data);
      if (result.length > total) throw new Error('Incomplete Zotero response: count does not match Total-Results.');
      const next = nextLink(header(response.headers, 'link'));
      if (result.length === total) {
        if (next) throw new Error('Incomplete Zotero pagination: extra page after Total-Results.');
        url = undefined;
      } else {
        if (!next) throw new Error('Incomplete Zotero pagination: next page is missing.');
        const nextUrl: URL = new URL(next, url);
        if (nextUrl.origin !== this.base.origin || nextUrl.pathname !== initial.pathname || nextUrl.username || nextUrl.password || nextUrl.hash) {
          throw new Error('Refusing a Zotero pagination link outside the requested loopback endpoint.');
        }
        // Pagination may only alter its cursor and size, never the query or library being fetched.
        for (const [name, value] of initial.searchParams) {
          if (!['start', 'limit'].includes(name) && nextUrl.searchParams.get(name) !== value) {
            throw new Error('Zotero pagination changed the requested query.');
          }
        }
        for (const name of nextUrl.searchParams.keys()) {
          if (!initial.searchParams.has(name) && !['start', 'limit'].includes(name)) throw new Error('Zotero pagination changed the requested query.');
        }
        url = nextUrl;
      }
    }
    const keys = result.map(row => (row as { key?: unknown; id?: unknown })?.key ?? (row as { id?: unknown })?.id);
    if (keys.some(key => typeof key !== 'string' && typeof key !== 'number') || new Set(keys).size !== keys.length) {
      throw new Error('Incomplete Zotero pagination: missing or duplicate object identities.');
    }
    return result;
  }

  private request(url: URL, options: RequestOptions = {}): Promise<Response> {
    if (url.origin !== this.base.origin || !url.pathname.startsWith('/api/')) throw new Error('Refusing a non-loopback Zotero request.');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
      };
      const headers: Record<string, string> = { Accept: 'application/json', 'Zotero-API-Version': '3' };
      if (!options.discovery && this.serverId) headers['Zotero-Server-ID'] = this.serverId;
      const request = http.request(url, { method: 'GET', headers, agent: false }, response => {
        const status = response.statusCode || 0;
        if (status !== 200 && !(options.allowNotFound && status === 404)) {
          response.resume();
          finish(new Error(status === 412 ? 'Zotero server changed. Reconnect and discard the previous server’s cached data.'
            : status === 403 ? 'Zotero local API is disabled. Enable communication with other applications in Zotero Settings → Advanced.'
            : status === 404 ? 'The selected Zotero item or collection is no longer available. Existing notes were preserved.'
            : `Zotero returned HTTP ${status}. Existing notes were preserved.`));
          request.destroy();
          return;
        }
        if (header(response.headers, 'zotero-api-version') !== '3') {
          response.resume(); finish(new Error('Incompatible Zotero API response; version 3 is required.')); request.destroy(); return;
        }
        const sid = header(response.headers, 'zotero-server-id');
        if (!sid || (!options.discovery && sid !== this.serverId)) {
          response.resume(); finish(new Error('Zotero server changed or omitted its identity. Reconnect before refreshing notes.')); request.destroy(); return;
        }
        if (options.expectedVersion && header(response.headers, 'last-modified-version') !== options.expectedVersion) {
          response.resume(); finish(new Error('Zotero library changed while reading. Refresh again; existing notes were preserved.')); request.destroy(); return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024 * 1024) {
            finish(new Error('Zotero response exceeds the safe metadata limit.'));
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('aborted', () => finish(new Error('Zotero returned a truncated response. Existing notes were preserved.')));
        response.on('error', () => finish(new Error('Zotero response could not be read completely. Existing notes were preserved.')));
        response.on('end', () => {
          if (!response.complete) finish(new Error('Zotero returned an incomplete response. Existing notes were preserved.'));
          else finish(undefined, { body: Buffer.concat(chunks).toString('utf8'), headers: response.headers, url, status });
        });
      });
      const timer = setTimeout(() => {
        finish(new Error('Zotero request timed out. Open Zotero and try again; existing notes were preserved.'));
        request.destroy();
      }, this.timeoutMs);
      request.on('error', () => finish(new Error('Cannot reach Zotero. Open Zotero and enable its local API; existing notes were preserved.')));
      request.end();
    });
  }
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value || '';
}
function positiveId(id: unknown): boolean { return typeof id === 'number' && Number.isSafeInteger(id) && id > 0; }
function prefix(library: Library): string {
  if (!['user', 'group'].includes(library.type) || !positiveId(library.id)) throw new Error('Invalid Zotero library identity.');
  return `${library.type === 'user' ? 'users' : 'groups'}/${library.id}`;
}
function validKey(key: string): void { if (!KEY.test(key)) throw new Error('Invalid Zotero item or collection key.'); }
function deleted(item: ZoteroItem): boolean { return Boolean(item.data.deleted); }
function isPaper(item: ZoteroItem): boolean { return !deleted(item) && !NON_PAPERS.has(item.data.itemType) && !item.data.parentItem; }
function checkLibrary(raw: unknown, expected: Library): void {
  const library = (raw as { library?: RawLibrary }).library;
  if (library && (library.type !== expected.type || library.id !== expected.id)) throw new Error('Zotero returned an item from a different library.');
}
function rejectDuplicates(items: ZoteroItem[]): void {
  if (new Set(items.map(item => item.key)).size !== items.length) throw new Error('Incomplete Zotero bundle: duplicate child identities.');
}
function nextLink(link: string): string | undefined {
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].filter(match => match[2].split(/\s+/).includes('next'));
  if (matches.length > 1) throw new Error('Incomplete Zotero pagination: multiple next pages.');
  return matches[0]?.[1];
}
