import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const versions = JSON.parse(await readFile('versions.json', 'utf8'));
if (manifest.id !== 'zotero-bridge' || manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('Package, manifest and versions.json must agree before release.');
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) {
  throw new Error('Release tag must match the manifest version.');
}

// Store a fixed set of files in a reproducible ZIP. No local settings or data
// are included. Stored entries need no ZIP dependency or platform-specific CLI.
const files = await Promise.all(['main.js', 'manifest.json', 'styles.css'].map(async name => ({
  name, bytes: await readFile(`dist/${name}`),
})));
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(`${manifest.id}/${file.name}`, 'utf8');
  const checksum = crc32(file.bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); // UTF-8 names, stored compression method.
  header.writeUInt16LE(33, 12); // 1980-01-01; fixed date for deterministic output.
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(file.bytes.length, 18);
  header.writeUInt32LE(file.bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, file.bytes);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x800, 8);
  directory.writeUInt16LE(33, 14);
  directory.writeUInt32LE(checksum, 16);
  directory.writeUInt32LE(file.bytes.length, 20);
  directory.writeUInt32LE(file.bytes.length, 24);
  directory.writeUInt16LE(name.length, 28);
  directory.writeUInt32LE(offset, 42);
  central.push(directory, name);
  offset += header.length + name.length + file.bytes.length;
}
const directoryBytes = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directoryBytes.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directoryBytes, end]);
await writeFile('dist/zotero-bridge.zip', zip);
const checksums = [...files, {name: 'zotero-bridge.zip', bytes: zip}]
  .map(file => `${createHash('sha256').update(file.bytes).digest('hex')}  ${file.name}`).join('\n');
await writeFile('dist/SHA256SUMS.txt', `${checksums}\n`);
console.log(`Prepared Zotero Bridge ${manifest.version}: ${files.length} plugin files and install ZIP.`);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
