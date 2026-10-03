import { createHash } from 'node:crypto';
import type { Identity, Paper } from './types';
import { identity, identityKey } from './types';
import { newNotePrefix } from './render';

const START = '<!-- zotero-bridge:start ';
const END = '<!-- zotero-bridge:end -->';
const RESERVED = '<!-- zotero-bridge';

export class ManagedConflict extends Error {
  constructor(message: string) { super(message); this.name = 'ManagedConflict'; }
}

export interface ManagedBlock {
  identity: Identity; content: string; hash: string; start: number; end: number;
}

function validIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Identity;
  return (candidate.type === 'user' || candidate.type === 'group') &&
    Number.isSafeInteger(candidate.id) && candidate.id >= 0 &&
    typeof candidate.key === 'string' && /^[A-Z0-9]{8}$/.test(candidate.key);
}

function checksum(value: Identity, content: string): string {
  return createHash('sha256').update(`${identityKey(value)}\n${content}`, 'utf8').digest('hex');
}

/** Indices include both marker comments but exclude their neighboring newlines. */
export function parseManaged(text: string): ManagedBlock | null {
  if (!text.includes(RESERVED)) return null;
  const start = text.indexOf(START);
  if (start < 0 || text.slice(0, start).includes(RESERVED)) {
    throw new ManagedConflict('The Zotero section has malformed markers.');
  }
  const headerEnd = text.indexOf(' -->', start + START.length);
  if (headerEnd < 0) throw new ManagedConflict('The Zotero section has an incomplete header.');
  let header: {version?: unknown; identity?: unknown; sha256?: unknown};
  try { header = JSON.parse(text.slice(start + START.length, headerEnd)); }
  catch { throw new ManagedConflict('The Zotero section has an invalid identity header.'); }
  if (!header || header.version !== 1 || !validIdentity(header.identity) ||
      typeof header.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(header.sha256)) {
    throw new ManagedConflict('The Zotero section has an unsupported or invalid header.');
  }
  const afterHeader = headerEnd + 4;
  const openingNewline = text.slice(afterHeader, afterHeader + 2) === '\r\n' ? 2 :
    text[afterHeader] === '\n' ? 1 : 0;
  const contentStart = afterHeader + openingNewline;
  const footerStart = text.indexOf(END, contentStart);
  if (!openingNewline || footerStart < 0 || text[footerStart - 1] !== '\n') {
    throw new ManagedConflict('The Zotero section has malformed or missing boundary markers.');
  }
  const contentEnd = text[footerStart - 2] === '\r' ? footerStart - 2 : footerStart - 1;
  const content = text.slice(contentStart, contentEnd);
  const end = footerStart + END.length;
  if (content.includes(RESERVED) || text.slice(end).includes(RESERVED)) {
    throw new ManagedConflict('This note has duplicate or nested Zotero section markers.');
  }
  const hash = checksum(header.identity, content);
  if (hash !== header.sha256) {
    throw new ManagedConflict('The generated Zotero section was edited; preserve or move those edits before refreshing.');
  }
  return { identity: header.identity, content, hash, start, end };
}

export function wrapManaged(value: Identity, content: string): string {
  if (!validIdentity(value)) throw new ManagedConflict('Invalid Zotero paper identity.');
  if (content.includes(RESERVED)) throw new ManagedConflict('Generated content contains reserved Zotero markers.');
  const header = { version: 1, identity: value, sha256: checksum(value, content) };
  return `${START}${JSON.stringify(header)} -->\n${content}\n${END}`;
}

/** Preserves every byte represented by the string outside the managed section. */
export function planUpdate(original: string | null, paper: Paper, content: string): {text: string; changed: boolean} {
  const value = identity(paper);
  const block = wrapManaged(value, content);
  if (original === null) return { text: `${newNotePrefix(paper)}${block}\n`, changed: true };
  const existing = parseManaged(original);
  if (!existing) {
    const separator = original.endsWith('\n\n') || original.endsWith('\r\n\r\n') ? '' :
      original.endsWith('\n') ? '\n' : '\n\n';
    return {text: `${original}${separator}${block}\n`, changed: true};
  }
  if (identityKey(existing.identity) !== identityKey(value)) {
    throw new ManagedConflict('This note is already connected to a different Zotero paper.');
  }
  if (existing.content === content) return {text: original, changed: false};
  const text = `${original.slice(0, existing.start)}${block}${original.slice(existing.end)}`;
  return {text, changed: text !== original};
}
