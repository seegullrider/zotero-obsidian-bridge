import { lstat, open, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { Asset, Library, PaperBundle } from './types';

export interface AssetConfig {
  dataDirectory: string;
  /** Optional cache root from a previous installation. Read-only. */
  legacyCacheDirectory: string;
  assetFolder: string;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KEY = /^[A-Z0-9]{8}$/;

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function assetPath(library: Library, annotationKey: string, folder: string): string {
  if (!KEY.test(annotationKey)) throw new Error(`Unsafe annotation key: ${annotationKey}`);
  if (!['user', 'group'].includes(library.type) || !Number.isSafeInteger(library.id) || library.id < 0) {
    throw new Error('Invalid Zotero library identity for image cache');
  }
  const normalized = folder.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || /[:\x00-\x1f]/.test(normalized)
      || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Image folder must be a safe vault-relative path');
  }
  return `${normalized}/${library.type}-${library.id}/${annotationKey}.png`;
}

/** A cache is trusted only as a source of PNG bytes, never as a writable directory. */
async function readPng(cacheRoot: string, relative: string): Promise<Uint8Array | undefined> {
  if (!cacheRoot || !path.isAbsolute(cacheRoot)) throw new Error('Zotero cache directory must be absolute');
  const root = path.resolve(cacheRoot);
  const filename = path.resolve(root, relative);
  const within = path.relative(root, filename);
  if (!within || within.startsWith(`..${path.sep}`) || within === '..' || path.isAbsolute(within)) {
    throw new Error('Image cache path escapes its root');
  }
  // Check ancestors as well as descendants: a junction in the configured root is
  // still symlink traversal. An absent path is ordinary missing cache data.
  const parsed = path.parse(filename);
  const parts = filename.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const parents: Array<{filename: string; ino: number; dev: number}> = [];
  let current = parsed.root;
  try {
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing image cache symlink or junction: ${current}`);
      if (current !== filename && !stat.isDirectory()) throw new Error(`Image cache parent is not a directory: ${current}`);
      if (current === filename && !stat.isFile()) throw new Error(`Image cache is not a regular file: ${current}`);
      if (current !== filename) parents.push({filename: current, ino: stat.ino, dev: stat.dev});
    }
    // Windows realpath expands DOS short names (e.g. RUNNER~1). Compare against
    // the canonical root rather than rejecting a legitimate spelling alias.
    // Ancestors were checked independently so canonicalizing cannot hide links.
    const canonicalRoot = await realpath(root);
    const actual = await realpath(filename);
    if (path.relative(path.resolve(canonicalRoot, within), actual) !== '') {
      throw new Error(`Image cache resolves outside its expected path: ${filename}`);
    }
    await checkParents();
    const before = await lstat(filename);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Image cache changed before opening: ${filename}`);
    const handle = await open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) {
        throw new Error(`Image cache changed while opening: ${filename}`);
      }
      const bytes = await handle.readFile();
      const after = await lstat(filename);
      if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev
          || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error(`Image cache changed while reading: ${filename}`);
      }
      await checkParents();
      if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
        throw new Error(`Invalid PNG image cache: ${filename}`);
      }
      return Uint8Array.from(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Permission, I/O and malformed-cache errors abort the refresh. Treating them
    // as missing could replace valid generated data with misleading placeholders.
    if (missing(error)) return undefined;
    throw error;
  }

  async function checkParents(): Promise<void> {
    for (const parent of parents) {
      const stat = await lstat(parent.filename);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino !== parent.ino || stat.dev !== parent.dev) {
        throw new Error(`Image cache parent changed while reading: ${parent.filename}`);
      }
    }
  }
}

export async function resolveAssets(
  bundle: PaperBundle,
  config: AssetConfig,
  existsInVault?: (path: string) => Promise<boolean>,
): Promise<Asset[]> {
  const visuals = bundle.annotations.filter(annotation => ['image', 'ink'].includes(annotation.data.annotationType ?? ''));
  const seen = new Set<string>();
  const result: Asset[] = [];
  for (const annotation of visuals) {
    if (seen.has(annotation.key)) throw new Error(`Duplicate visual annotation key: ${annotation.key}`);
    seen.add(annotation.key);
    const target = assetPath(bundle.library, annotation.key, config.assetFolder);
    const relative = bundle.library.type === 'group'
      ? path.join('groups', String(bundle.library.id), `${annotation.key}.png`)
      : path.join('library', `${annotation.key}.png`);
    let bytes: Uint8Array | undefined;
    if (config.dataDirectory) bytes = await readPng(path.join(config.dataDirectory, 'cache'), relative);
    if (!bytes && config.legacyCacheDirectory) bytes = await readPng(config.legacyCacheDirectory, relative);
    if (bytes) {
      result.push({ annotationKey: annotation.key, path: target, status: 'available', bytes });
    } else if (existsInVault && await existsInVault(target)) {
      // A missing machine-local cache must never erase a recovered vault image.
      result.push({ annotationKey: annotation.key, path: target, status: 'available' });
    } else {
      result.push({ annotationKey: annotation.key, path: target, status: 'missing', reason: 'Image is unavailable in the local Zotero caches; open the annotation in Zotero.' });
    }
  }
  return result;
}
