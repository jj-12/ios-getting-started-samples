const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crc32, zipStore, dosDateTime } = require('../timelapse/zip.js');

const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

describe('crc32', () => {
  it('matches known CRC-32 values', () => {
    assert.equal(crc32(bytes('')), 0);
    assert.equal(crc32(bytes('hello world')), 0x0d4a1185);
    assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  });

  it('agrees with zlib for binary data', () => {
    const zlib = require('node:zlib');
    const data = Uint8Array.from({ length: 1024 }, (_, i) => (i * 37 + 11) & 0xff);
    assert.equal(crc32(data), zlib.crc32(Buffer.from(data)));
  });
});

describe('zipStore', () => {
  const entries = [
    { name: 'frame-0001.jpg', data: bytes('first frame bytes') },
    { name: 'frame-0002.jpg', data: bytes('second frame bytes, a little longer') },
  ];

  it('writes the archive signatures and entry count', () => {
    const zip = zipStore(entries, new Date(2024, 4, 6, 10, 30, 0));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50, 'local header');
    const eocd = zip.length - 22;
    assert.equal(view.getUint32(eocd, true), 0x06054b50, 'end of central directory');
    assert.equal(view.getUint16(eocd + 10, true), entries.length);
  });

  it('produces an archive real unzip tools accept', () => {
    let unzip;
    try {
      unzip = execFileSync('which', ['unzip']).toString().trim();
    } catch {
      return; // no unzip on this machine; the structural checks still ran
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ziptest-'));
    const file = path.join(dir, 'frames.zip');
    fs.writeFileSync(file, Buffer.from(zipStore(entries, new Date(2024, 4, 6, 10, 30, 0))));
    execFileSync(unzip, ['-tqq', file]);
    execFileSync(unzip, ['-qq', file, '-d', dir]);
    for (const e of entries) {
      assert.equal(fs.readFileSync(path.join(dir, e.name), 'utf8'), Buffer.from(e.data).toString('utf8'));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles an empty archive', () => {
    const zip = zipStore([], new Date(2024, 0, 1));
    assert.equal(zip.length, 22);
  });

  it('packs DOS date/time fields', () => {
    const { time, date } = dosDateTime(new Date(2024, 4, 6, 10, 30, 4));
    assert.equal((date >> 9) + 1980, 2024);
    assert.equal((date >> 5) & 15, 5);
    assert.equal(date & 31, 6);
    assert.equal(time >> 11, 10);
    assert.equal((time >> 5) & 63, 30);
  });
});
