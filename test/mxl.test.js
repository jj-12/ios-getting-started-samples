const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readZipEntries, extractMusicXml } = require('../transposer/mxl.js');

// Minimal ZIP writer (deflate, no zip64) to build .mxl fixtures in-memory.
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    chunks.push(local, nameBuf, comp);
    offset += local.length + nameBuf.length + comp.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10); // deflate
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const SCORE = '<?xml version="1.0"?><score-partwise version="3.1"><part-list/></score-partwise>';
const CONTAINER =
  '<?xml version="1.0"?><container><rootfiles>' +
  '<rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/>' +
  '</rootfiles></container>';

describe('readZipEntries', () => {
  it('lists entries and inflates them', async () => {
    const zip = buildZip({ 'a.txt': 'hello', 'b.txt': 'world' });
    const entries = readZipEntries(new Uint8Array(zip));
    assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'b.txt']);
    assert.equal(new TextDecoder().decode(await entries[0].bytes()), 'hello');
    assert.equal(new TextDecoder().decode(await entries[1].bytes()), 'world');
  });

  it('rejects non-zip data', () => {
    assert.throws(() => readZipEntries(new Uint8Array(100)), /Not a ZIP/);
  });
});

describe('extractMusicXml', () => {
  it('follows META-INF/container.xml to the root score', async () => {
    const zip = buildZip({
      'META-INF/container.xml': CONTAINER,
      'other.xml': '<not-it/>',
      'score.xml': SCORE,
    });
    const xml = await extractMusicXml(new Uint8Array(zip));
    assert.match(xml, /score-partwise/);
  });

  it('falls back to the first non-META-INF xml entry', async () => {
    const zip = buildZip({ 'piece.musicxml': SCORE, 'readme.txt': 'hi' });
    const xml = await extractMusicXml(new Uint8Array(zip));
    assert.match(xml, /score-partwise/);
  });

  it('errors when no score is present', async () => {
    const zip = buildZip({ 'readme.txt': 'hi' });
    await assert.rejects(() => extractMusicXml(new Uint8Array(zip)), /No MusicXML/);
  });
});
