import {homedir} from 'node:os';
import {join} from 'node:path';

export type Library = { type: 'user' | 'group'; id: number; name: string };
export type Creator = { firstName?: string; lastName?: string; name?: string; creatorType?: string };
export interface ItemData {
  key?: string; itemType: string; title?: string; citationKey?: string; date?: string;
  creators?: Creator[]; DOI?: string; url?: string; abstractNote?: string;
  publicationTitle?: string; tags?: {tag: string}[]; parentItem?: string;
  contentType?: string; filename?: string; linkMode?: string; note?: string;
  annotationType?: string; annotationText?: string; annotationComment?: string;
  annotationColor?: string; annotationPageLabel?: string; annotationSortIndex?: string;
  annotationPosition?: string; deleted?: boolean | number; [field: string]: unknown;
}
export interface ZoteroItem { key: string; version?: number; data: ItemData; bib?: string; }
export interface Paper { library: Library; item: ZoteroItem; }
export interface Collection { key: string; data: {name: string; parentCollection?: string | false}; }
export interface PaperBundle extends Paper {
  attachments: ZoteroItem[]; notes: ZoteroItem[]; annotations: ZoteroItem[];
}
export interface Asset {
  annotationKey: string; path: string; bytes?: Uint8Array;
  status: 'available' | 'missing'; reason?: string;
}
export interface Identity { type: Library['type']; id: number; key: string; }
export interface RootInfo { apiVersion: string; serverId: string; zoteroVersion: string; }
export interface Settings {
  schemaVersion: 1; noteFolder: string; assetFolder: string; dataDirectory: string;
  legacyCacheDirectory: string; mappings: Record<string, string>;
  serverId: string; paperCache: Paper[];
}
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1, noteFolder: 'physics/literature', assetFolder: 'attachments/zotero-bridge',
  dataDirectory: join(homedir(), 'Zotero'), legacyCacheDirectory: '',
  mappings: {}, serverId: '', paperCache: [],
};
export function identity(paper: Paper): Identity {
  return {type: paper.library.type, id: paper.library.id, key: paper.item.key};
}
export function identityKey(value: Identity): string { return `${value.type}:${value.id}:${value.key}`; }
