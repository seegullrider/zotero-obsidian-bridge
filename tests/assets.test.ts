import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { assetPath, resolveAssets } from '../src/assets';
import type { AssetConfig } from '../src/assets';
import type { PaperBundle } from '../src/types';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function bundle(type: 'user' | 'group' = 'user', key = 'ABC12345'): PaperBundle {
  return {
    library: { type, id: type === 'user' ? 0 : 23, name: 'Test' },
    item: { key: 'PAPER123', data: { itemType: 'journalArticle', title: 'Test' } },
    attachments: [], notes: [],
    annotations: [{ key, data: { itemType: 'annotation', annotationType: 'image' } }],
  };
}
async function fixture(fn: (root: string, config: AssetConfig) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'zotero-bridge-assets-'));
  try {
    await fn(root, { dataDirectory: path.join(root, 'active'), legacyCacheDirectory: path.join(root, 'legacy'), assetFolder: 'attachments/zotero-bridge' });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function file(filename: string, bytes = png) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes);
}

test('missing visual becomes explicit placeholder, text annotations need no asset', async () => {
  await fixture(async (_root, config) => {
    const data = bundle();
    data.annotations.push({ key: 'TEXT1234', data: { itemType: 'annotation', annotationType: 'highlight' } });
    const assets = await resolveAssets(data, config);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].status, 'missing');
    assert.match(assets[0].reason!, /unavailable/);
    assert.equal(assets[0].path, 'attachments/zotero-bridge/user-0/ABC12345.png');
  });
});
test('active PNG wins over legacy PNG for the same key', async () => {
  await fixture(async (_root, config) => {
    await file(path.join(config.dataDirectory, 'cache', 'library', 'ABC12345.png'));
    await file(path.join(config.legacyCacheDirectory, 'library', 'ABC12345.png'), new Uint8Array([...png, 2]));
    const [asset] = await resolveAssets(bundle(), config);
    assert.equal(asset.status, 'available');
    assert.deepEqual(asset.bytes, png);
  });
});
test('legacy group cache restores images and ink without copying PDFs', async () => {
  await fixture(async (_root, config) => {
    await file(path.join(config.legacyCacheDirectory, 'groups', '23', 'ABC12345.png'));
    const data = bundle('group'); data.annotations[0].data.annotationType = 'ink';
    const [asset] = await resolveAssets(data, config);
    assert.equal(asset.status, 'available');
    assert.deepEqual(asset.bytes, png);
    assert.equal(asset.path, 'attachments/zotero-bridge/group-23/ABC12345.png');
  });
});
test('previous vault image stays available when both machine caches disappear', async () => {
  await fixture(async (_root, config) => {
    const [asset] = await resolveAssets(bundle(), config, async target => target.endsWith('/ABC12345.png'));
    assert.equal(asset.status, 'available');
    assert.equal(asset.bytes, undefined);
  });
});
test('invalid PNG aborts refresh instead of claiming a temporary filesystem failure is missing', async () => {
  await fixture(async (_root, config) => {
    await file(path.join(config.dataDirectory, 'cache', 'library', 'ABC12345.png'), Uint8Array.from([1, 2, 3]));
    await assert.rejects(resolveAssets(bundle(), config), /Invalid PNG/);
    await assert.rejects(resolveAssets(bundle(), { ...config, dataDirectory: '' }, async () => { throw new Error('EACCES'); }), /EACCES/);
  });
});
test('reject path traversal, invalid keys, absolute vault paths and malformed library ids', async () => {
  await fixture(async (_root, config) => {
    await assert.rejects(resolveAssets(bundle('user', '../x.png'), config), /Unsafe annotation key/);
    for (const folder of ['../out', 'C:/out', '/out', 'folder//out', 'folder/./out']) {
      assert.throws(() => assetPath(bundle().library, 'ABC12345', folder), /vault-relative/);
    }
    assert.throws(() => assetPath({ type: 'group', id: -1, name: '' }, 'ABC12345', 'assets'), /library identity/);
  });
});
test('duplicate image keys cannot overwrite each other', async () => {
  await fixture(async (_root, config) => {
    const data = bundle(); data.annotations.push(data.annotations[0]);
    await assert.rejects(resolveAssets(data, config), /Duplicate visual annotation/);
  });
});
test('refuses directory junctions and symlink cache files', async () => {
  await fixture(async (root, config) => {
    const real = path.join(root, 'real');
    await file(path.join(real, 'ABC12345.png'));
    await mkdir(path.join(config.dataDirectory, 'cache'), { recursive: true });
    await symlink(real, path.join(config.dataDirectory, 'cache', 'library'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveAssets(bundle(), config), /symlink or junction/);
  });
});
