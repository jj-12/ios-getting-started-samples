// Transposer — minimal .mxl (compressed MusicXML) reader.
//
// An .mxl file is a ZIP archive with a META-INF/container.xml naming the root
// score file. This reads the archive with plain DataView parsing and inflates
// entries via DecompressionStream('deflate-raw') — no library needed, and it
// runs both in browsers and under node:test (Node ≥ 18 has DecompressionStream).

(function () {
  const EOCD_SIG = 0x06054b50;
  const CENTRAL_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(
      new DecompressionStream('deflate-raw'),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Parse a ZIP archive into [{name, bytes()}] with lazy extraction.
  function readZipEntries(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const stop = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= stop; i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory)');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== CENTRAL_SIG) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
      entries.push({
        name,
        method,
        async bytes() {
          if (dv.getUint32(localOff, true) !== LOCAL_SIG) {
            throw new Error('Corrupt ZIP entry: ' + name);
          }
          const lNameLen = dv.getUint16(localOff + 26, true);
          const lExtraLen = dv.getUint16(localOff + 28, true);
          const start = localOff + 30 + lNameLen + lExtraLen;
          const data = bytes.subarray(start, start + compSize);
          if (method === 0) return data;
          if (method === 8) return inflateRaw(data);
          throw new Error('Unsupported ZIP compression method ' + method);
        },
      });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // Extract the root MusicXML document from an .mxl buffer as a string.
  async function extractMusicXml(buffer) {
    const entries = readZipEntries(buffer);
    const decoder = new TextDecoder();
    let rootPath = null;
    const container = entries.find((e) => e.name === 'META-INF/container.xml');
    if (container) {
      const xml = decoder.decode(await container.bytes());
      const m = xml.match(/full-path\s*=\s*"([^"]+)"/);
      if (m) rootPath = m[1];
    }
    const isScore = (name) =>
      !name.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(name);
    const entry =
      (rootPath && entries.find((e) => e.name === rootPath)) ||
      entries.find((e) => isScore(e.name));
    if (!entry) throw new Error('No MusicXML document found inside the .mxl file');
    return decoder.decode(await entry.bytes());
  }

  const api = { readZipEntries, extractMusicXml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Mxl = api;
})();
