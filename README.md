# Zotero Bridge

A desktop Obsidian plugin that imports selected Zotero papers, refreshes their annotations, and inserts paper links or individual IEEE references. Zotero supplies metadata and annotations; your summaries and research connections stay in ordinary Markdown.

Zotero Bridge uses the [documented Zotero local API](https://www.zotero.org/support/dev/web_api/v3/local_api) and Obsidian's [public plugin API](https://github.com/obsidianmd/obsidian-api). It requires no Zotero extension, Python service, Better BibTeX, or online API key.

## Install

Requires **Zotero 10 or newer**, local API version 3, and desktop **Obsidian 1.5 or newer**. Version 1.0.1 was tested with Zotero **10.0.5** and Obsidian **1.13.7** on Windows. Automated tests also run on Linux; macOS and Linux desktop use have not yet been tested.

1. Download the plugin bundle from the [latest GitHub release](https://github.com/seegullrider/zotero-obsidian-bridge/releases/latest).
2. Close Obsidian. Create `<vault>/.obsidian/plugins/zotero-bridge/` and put `main.js`, `manifest.json`, and `styles.css` directly inside it. Extract the release ZIP first if you downloaded the ZIP.
3. Open Obsidian. In **Settings → Community plugins**, turn on community plugins if needed, then enable **Zotero Bridge**. The GitHub release is a manual installation; this plugin is not yet listed in Obsidian's community directory.
4. Keep Zotero running. In Zotero **Settings → Advanced**, enable **Allow other applications on this computer to communicate with Zotero**. The plugin reads `http://127.0.0.1:23119/api/` directly.
5. Review the Zotero Bridge settings below. Run **Import papers**, select one paper, and inspect the preview before applying it.

The plugin needs a stable personal-library user ID. If it cannot establish one, sign in to your Zotero account and try again. Personal and group libraries remain distinct in the picker and note identities.

## Commands

Open Obsidian's command palette and search **Zotero Bridge**:

| Command | Result |
| --- | --- |
| **Import papers** | Search title, authors, year, and citation key; select papers individually or from a collection; preview and apply. |
| **Refresh current paper** | Preview current Zotero data for the open connected literature note. |
| **Refresh connected papers** | Preview updates for all connected notes. |
| **Insert paper link** | Insert a link using the actual note path and paper title, or a Zotero item link if no note exists. |
| **Insert IEEE reference** | Insert one formatted Markdown reference, without an isolated `[1]` number. |
| **Audit connections** | Report conflicted sections, missing records, ambiguous connections, broken literature links, duplicate candidates, and unavailable images. |

Imports and refreshes run only when requested. Applying the preview reports updated and unchanged notes, skipped conflicts, and unavailable images. An unchanged refresh does not rewrite notes or duplicate annotations. Inserting a link does not import a paper.

## Notes and personal writing

New notes default to `physics/literature/@citekey.md`; change the folder in plugin settings to suit your vault. Papers without citation keys use their item keys. Filename collisions gain a library/item suffix. Existing connected notes retain their paths when citation keys change, and user-initiated note or folder moves update their mappings.

Each connected note has one **Current Zotero data** section containing metadata, abstract, Zotero notes, annotations, and source links. Refresh replaces only this section. Other content, including frontmatter and personal writing before or after it, stays unchanged. Annotations are ordered by page and retain color labels, comments, and stable block IDs. PDF links use physical page indices where available.

Write your summaries and comments outside the generated section. Editing the generated section or its hidden markers causes refresh to skip that note. The markers contain the paper's stable identity and a checksum, allowing connections to be recovered if plugin settings are lost.

Existing notes without Zotero Bridge markers are not connected automatically from their filenames or titles. Import creates a separate note rather than overwriting an unrelated note. Audits report legacy links but do not rewrite existing passages or merge Zotero records.

## Settings and annotation images

| Setting | Default and use |
| --- | --- |
| **New literature note folder** | `physics/literature`, relative to the vault. Applies to new notes. |
| **Imported image folder** | `attachments/zotero-bridge`, relative to the vault. Images are organized by library and annotation key. |
| **Zotero data directory** | `Zotero` inside your operating-system home directory. Used only to read cached annotation PNGs. Set this to your actual Zotero data directory if you moved it. |
| **Optional old image-cache directory** | Empty. An optional read-only fallback pointing directly to another Zotero `cache` directory. |

The image adapter reads Zotero's annotation caches and copies available PNGs into the vault. It also retains existing vault images when a local cache is missing. Unavailable image/ink annotations keep their comments and Zotero links with an explicit placeholder. Opening the affected annotation in Zotero may regenerate a missing cache; then refresh again.

Zotero's cache layout is an internal interface, isolated in `src/assets.ts`. PDF crop reconstruction is not implemented. No full PDFs are copied to Obsidian. Notes and copied images remain readable on phones through your existing vault sync, even with the plugin disabled; imports and refreshes require desktop. Zotero desktop links depend on Zotero being available on the device.

## Safety, privacy, and updates

- Zotero requests are GET-only and stay on loopback, bypassing proxies. The plugin does not contact GitHub or other external services.
- Identity is library type + user/group ID + item key. Titles, DOIs, and citation keys are searchable attributes, not identities.
- Cached metadata is partitioned by Zotero server ID. Switching databases invalidates the old cache.
- Incomplete requests, incompatible API responses, malformed markers, manual edits, and concurrent note edits prevent affected note updates. Missing or trashed papers leave their existing notes intact.
- Before overwriting notes or images, the plugin saves originals under `.obsidian/plugins/zotero-bridge/backups/<timestamp>/`. It does not delete notes, imported images, or Zotero records.

Plugin `data.json` contains local settings, note mappings, and cached paper metadata. Treat it, your vault, and backup folders as personal data; they are not part of the public source or release bundle.

Continue following official Zotero and Obsidian releases. To update the bridge, keep the last working bundle, disable the plugin, replace its three plugin files with a new release, and enable it again. Preserve `data.json` and `backups/`. Test a refresh on one note before refreshing all connected notes. Major API changes can be repaired in `src/api.ts`; cache changes can be repaired independently in `src/assets.ts`.

## Troubleshooting and rollback

- **Cannot reach Zotero / local API disabled:** open Zotero and check the local API setting. Metadata import does not require internet access once your library is available locally.
- **Unsupported API version or missing server ID:** check the Zotero version. The bridge requires API version 3 and the server identity supplied by Zotero 10+. Existing notes are preserved.
- **Image unavailable:** confirm the data-directory setting and open the annotation in Zotero before refreshing. Check that the cache directory is readable; symlinks and junctions are intentionally refused by the image adapter.
- **Generated section edited / malformed markers:** copy your edits into a personal section, then restore the exact generated section from a known-good note backup. Removing the markers does not repair the connection. If unsure, retain the note and inspect the audit report before making changes.
- **More than one connected note:** run the audit and decide which note owns the connection. Automatic refresh skips duplicate mappings.
- **Plugin absent after installation:** check that the three files sit directly in `plugins/zotero-bridge/`, then restart Obsidian and enable the plugin in Community plugins.

Disabling Zotero Bridge stops all imports while leaving notes readable. To undo an applied update, disable the plugin, compare the timestamped backup with the current note, and restore the needed content while keeping subsequent personal edits. For a complete installation rollback, back up affected notes and `data.json` before migration, then restore those copies and your previous plugin enablement settings.

## Build and test

Use Node.js **22.13+** and pnpm. The lockfile records the dependency versions used to build the release.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm build
```

Run `pnpm release` to build the install ZIP and SHA-256 checksums. Pushing a version tag such as `v1.0.1` runs the Windows and Linux checks before publishing its five release assets on GitHub.

The esbuild platform binary is an optional dependency; dependency lifecycle scripts are not needed. Install `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` in your vault's plugin folder. `dist/bridge-core.cjs` is a standalone bundle for development diagnostics and is not required by Obsidian.

Tests cover API compatibility and incomplete reads, deterministic rendering, section integrity, image handling, identity/filename collisions, annotation changes, and concurrent updates. Live-app testing and platform verification remain separate from mocked unit tests.

The plugin is licensed under [MIT](LICENSE). Document-wide IEEE numbering, LaTeX citation management, automatic imports, PDF copying, and Zotero writes are outside v1.
