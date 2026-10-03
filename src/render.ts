import type { Asset, Library, Paper, PaperBundle, ZoteroItem } from './types';

const colors: Record<string, string> = {
  '#ffd400': 'Yellow', '#ff6666': 'Red', '#5fb236': 'Green', '#2ea8e5': 'Blue',
  '#a28ae5': 'Purple', '#e56eee': 'Magenta', '#f19837': 'Orange', '#aaaaaa': 'Gray',
};
const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', deg: '°', times: '×', minus: '−',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x';
      const point = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : '\uFFFD';
    }
    return entities[entity.toLowerCase()] ?? whole;
  });
}

function safePlain(value: unknown): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\^zotero-/gi, '\\^zotero-');
}
function markdownText(value: unknown): string {
  return safePlain(value).replace(/([\\`*_{}\[\]()#!|])/g, '\\$1');
}
function inline(value: unknown): string { return markdownText(value).replace(/\s*\n\s*/g, ' '); }
function escapeLinkUrl(value: string): string {
  return value.replace(/[\s<>()[\]"\\]/g, character => encodeURIComponent(character));
}
function safeUrl(value: string): string | null {
  const decoded = decodeEntities(value).trim();
  if (/^[\x00-\x20]/.test(decoded) || /[\x00-\x1f\x7f]/.test(decoded) ||
      !/^(?:https?:\/\/|zotero:\/\/)/i.test(decoded)) return null;
  return escapeLinkUrl(decoded);
}
function attr(tag: string, name: string): string {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(expression);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : '';
}

/** Restricts HTML to readable Markdown. No scripts, raw HTML, or embedded remote images. */
export function htmlToMarkdown(html: string): string {
  let value = String(html ?? '').replace(/\r\n?/g, '\n');
  value = value.replace(/<(script|style|iframe|object|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  value = value.replace(/<!--[\s\S]*?-->/g, '');
  value = value.replace(/<img\b[^>]*>/gi, tag => `[Image${attr(tag, 'alt') ? `: ${attr(tag, 'alt')}` : ''}]`);
  value = value.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attributes: string, label: string) => {
    const href = safeUrl(attr(attributes, 'href'));
    const readable = label.replace(/<[^>]*>/g, '');
    return href ? `[${readable.replace(/([\[\]])/g, '\\$1')}](${href})` : readable;
  });
  value = value.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, '**$1**');
  value = value.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, '*$1*');
  value = value.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, code: string) => {
    const runs = code.match(/`+/g) ?? [];
    const delimiter = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1);
    return `${delimiter} ${code} ${delimiter}`;
  });
  value = value.replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${'#'.repeat(Math.min(6, Number(level) + 3))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n');
  value = value.replace(/<br\b[^>]*\/?\s*>/gi, '\n');
  value = value.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li\s*>/gi, '\n');
  value = value.replace(/<\/?(?:p|div|section|article|blockquote|ul|ol|pre|table|tr|hr)\b[^>]*>/gi, '\n\n');
  value = value.replace(/<\/?(?:td|th)\b[^>]*>/gi, ' | ');
  value = value.replace(/<[^>]*>/g, '');
  // Escape HTML after decoding too, so encoded tags cannot become active HTML.
  value = safePlain(decodeEntities(value));
  // A note's pre-existing Markdown-like text must not become an image request.
  value = value.replace(/!\[/g, '\\![');
  return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function libraryPath(library: Library): string {
  return library.type === 'group' ? `groups/${library.id}` : 'library';
}
export function zoteroItemLink(paper: Paper): string {
  return `zotero://select/${libraryPath(paper.library)}/items/${encodeURIComponent(paper.item.key)}`;
}
function physicalPage(annotation: ZoteroItem): number | null {
  try {
    const position = JSON.parse(String(annotation.data.annotationPosition ?? '{}'));
    return Number.isSafeInteger(position.pageIndex) && position.pageIndex >= 0 ? position.pageIndex + 1 : null;
  } catch { return null; }
}
export function pdfAnnotationLink(library: Library, attachmentKey: string, annotation: ZoteroItem): string {
  if (!attachmentKey) return `zotero://select/${libraryPath(library)}/items/${encodeURIComponent(annotation.key)}`;
  const page = physicalPage(annotation);
  const query = [page === null ? '' : `page=${page}`, `annotation=${encodeURIComponent(annotation.key)}`].filter(Boolean).join('&');
  return `zotero://open-pdf/${libraryPath(library)}/items/${encodeURIComponent(attachmentKey)}?${query}`;
}
export function paperLink(paper: Paper, notePath?: string): string {
  const title = String(paper.item.data.title || paper.item.key);
  if (!notePath) return `[${inline(title)}](${zoteroItemLink(paper)})`;
  const path = notePath.replace(/\\/g, '/').replace(/\.md$/i, '');
  // Names with wiki-link separators require an ordinary encoded Markdown link.
  if (/[\[\]#|?]/.test(path)) {
    const target = notePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return `[${inline(title)}](${target})`;
  }
  const display = safePlain(title).replace(/\|/g, '&#124;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/\n/g, ' ');
  return `[[${path}|${display}]]`;
}
function authors(paper: Paper): string {
  return (paper.item.data.creators ?? []).map(creator => creator.name ||
    [creator.firstName, creator.lastName].filter(Boolean).join(' ')).filter(Boolean).join('; ');
}
export function newNotePrefix(paper: Paper): string {
  const data = paper.item.data;
  const fields = [
    '---', 'type: literature', `title: ${JSON.stringify(String(data.title ?? ''))}`,
    `citekey: ${JSON.stringify(String(data.citationKey ?? ''))}`,
    `zotero_library_type: ${JSON.stringify(paper.library.type)}`, `zotero_library_id: ${paper.library.id}`,
    `zotero_item_key: ${JSON.stringify(paper.item.key)}`, '---', '', `# ${inline(data.title || paper.item.key)}`, '',
    '## 总结 / Summary', '', '## 背景 / Background', '', '## 结果 / Results', '',
    '## 方法 / Methods', '', '## 与我的研究的联系 / Research connections', '',
    '## 可以怎么用 / Uses', '', '## 问题 / Questions', '', '',
  ];
  return fields.join('\n');
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function sortedAnnotations(items: ZoteroItem[]): ZoteroItem[] {
  return [...items].sort((left, right) => {
    const pageLeft = physicalPage(left) ?? Number.MAX_SAFE_INTEGER;
    const pageRight = physicalPage(right) ?? Number.MAX_SAFE_INTEGER;
    return pageLeft - pageRight || compare(String(left.data.annotationSortIndex ?? ''), String(right.data.annotationSortIndex ?? '')) ||
      compare(left.key, right.key);
  });
}
function quote(value: string): string { return markdownText(value).split('\n').map(line => `> ${line}`).join('\n'); }
function assetPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  return !normalized || /^(?:\/|[a-z]:)/i.test(normalized) || /[\[\]|#\r\n]/.test(normalized) ||
    normalized.split('/').some(part => part === '..' || part === '.') ? null : normalized;
}

export function renderManaged(bundle: PaperBundle, assets: Asset[]): string {
  const data = bundle.item.data;
  const lines = ['## Current Zotero data', '', `**Title:** ${inline(data.title || bundle.item.key)}`,
    `**Authors:** ${inline(authors(bundle) || 'Not recorded')}`, `**Date:** ${inline(data.date || 'Not recorded')}`,
    `**Library:** ${inline(bundle.library.name)} (${bundle.library.type}:${bundle.library.id})`,
    `**Citation key:** ${inline(data.citationKey || 'Not recorded')}`];
  if (data.publicationTitle) lines.push(`**Publication:** ${inline(data.publicationTitle)}`);
  const tags = [...new Set((data.tags ?? []).map(tag => tag.tag))].sort(compare);
  if (tags.length) lines.push(`**Tags:** ${tags.map(inline).join(', ')}`);
  lines.push('', '### Source links', '', `- [Open in Zotero](${zoteroItemLink(bundle)})`);
  if (data.DOI) {
    const doi = String(data.DOI).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
    if (doi) lines.push(`- [DOI](https://doi.org/${escapeLinkUrl(doi)})`);
  }
  if (data.url && safeUrl(data.url)) lines.push(`- [Original source](${safeUrl(data.url)})`);
  const attachments = [...bundle.attachments].sort((left, right) => compare(left.key, right.key));
  for (const attachment of attachments) {
    if (attachment.data.contentType === 'application/pdf') {
      lines.push(`- [PDF: ${inline(attachment.data.title || attachment.data.filename || attachment.key)}](zotero://open-pdf/${libraryPath(bundle.library)}/items/${encodeURIComponent(attachment.key)})`);
    }
    if (attachment.data.url && safeUrl(attachment.data.url)) {
      lines.push(`- [Attachment source: ${inline(attachment.data.title || attachment.key)}](${safeUrl(attachment.data.url)})`);
    }
  }
  lines.push('', '### Abstract', '', data.abstractNote ? markdownText(data.abstractNote) : '_No abstract recorded._');
  lines.push('', '### Zotero notes', '');
  const notes = [...bundle.notes].sort((left, right) => compare(left.key, right.key));
  if (!notes.length) lines.push('_No Zotero notes._');
  for (const note of notes) {
    lines.push(`#### Note ${inline(note.key)}`, '', htmlToMarkdown(note.data.note ?? '') || '_Empty note._', '');
  }
  lines.push('', '### Annotations', '');
  const annotationAssets = new Map(assets.map(asset => [asset.annotationKey, asset]));
  if (!bundle.annotations.length) lines.push('_No annotations._');
  for (const annotation of sortedAnnotations(bundle.annotations)) {
    const annotationData = annotation.data;
    const label = annotationData.annotationPageLabel || (physicalPage(annotation) === null ? 'Unknown' : String(physicalPage(annotation)));
    const color = String(annotationData.annotationColor || '').toLowerCase();
    const colorLabel = color ? `${colors[color] || 'Color'} (${color})` : 'No color recorded';
    lines.push(`#### Page ${inline(label)} · ${inline(colorLabel)}`, '',
      `[Open annotation](${pdfAnnotationLink(bundle.library, annotationData.parentItem || '', annotation)})`, '');
    if (annotationData.annotationText) lines.push(quote(annotationData.annotationText), '');
    if (annotationData.annotationComment) lines.push(`**Comment:** ${markdownText(annotationData.annotationComment)}`, '');
    const annotationTags = [...new Set((annotationData.tags ?? []).map(tag => tag.tag))].sort(compare);
    if (annotationTags.length) lines.push(`**Tags:** ${annotationTags.map(inline).join(', ')}`, '');
    if (['image', 'ink'].includes(annotationData.annotationType || '')) {
      const asset = annotationAssets.get(annotation.key);
      const path = asset?.status === 'available' ? assetPath(asset.path) : null;
      lines.push(path ? `![[${path}]]` : `> Visual unavailable for ${inline(annotation.key)}. ${inline(asset?.reason || 'The Zotero image cache was not found.')} Open the annotation in Zotero.`, '');
    }
    lines.push(`^zotero-${annotation.key}`, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
