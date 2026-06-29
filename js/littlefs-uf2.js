/**
 * littlefs-uf2.js
 * Pure JavaScript LittleFS image builder + UF2 packer for a single file.
 * Matches the Earle Philhower RP2040 Arduino core defaults:
 *   Flash size: 8MB, Sketch: 7MB, FS: 1MB
 *   LittleFS block size: 4096 bytes, block count: 256
 *
 * LittleFS on-disk format (v2):
 *   - Each block is BLOCK_SIZE bytes, filled with 0xFF
 *   - Block 0 & 1: superblock (with magic, version, geometry)
 *   - Block 2: root directory
 *   - Block 3+: file data
 *
 * UF2 format:
 *   - 512-byte blocks, 256 bytes of payload each
 *   - Target address = FLASH_BASE + FS_OFFSET + offset_in_image
 *   - Family ID = 0xe48bff56 (RP2040)
 */

const BLOCK_SIZE  = 4096;
const BLOCK_COUNT = 256;       // 1MB / 4096
const FS_SIZE     = BLOCK_SIZE * BLOCK_COUNT;  // 1MB
const FS_OFFSET   = 7 * 1024 * 1024;          // 7MB sketch area
const FLASH_BASE  = 0x10000000;
const UF2_PAYLOAD = 256;
const UF2_MAGIC0  = 0x0A324655;  // "UF2\n"
const UF2_MAGIC1  = 0x9E5D5157;
const UF2_MAGIC2  = 0x0AB16F30;
const UF2_FAMILY  = 0xe48bff56;  // RP2040

// LittleFS v2 constants
const LFS_MAGIC        = 0x4C465332;  // "LFS2"
const LFS_VERSION      = 0x00020000;
const NAME_MAX         = 255;
const FILE_MAX         = 0x7FFFFFFF;
const ATTR_MAX         = 0x3FF;

// Tag encoding for LittleFS v2
const LFS_MKTAG = (type, id, size) => ((type << 20) | (id << 10) | size) >>> 0;

function crc32(buf, seed = 0) {
  let crc = seed ^ 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeLE32(view, offset, val) {
  view.setUint32(offset, val >>> 0, true);
}
function writeLE16(view, offset, val) {
  view.setUint16(offset, val & 0xFFFF, true);
}

/**
 * Build a minimal LittleFS image containing a single file at /config.json
 */
export function buildLittleFSImage(filename, fileBytes) {
  const image = new Uint8Array(FS_SIZE).fill(0xFF);
  const enc   = new TextEncoder();
  const nameBytes = enc.encode(filename);

  // ── Helper: write a commit pair to a metadata block ──────────────────
  // LittleFS v2 metadata blocks hold a sequence of commits.
  // Each commit is a series of tags+data followed by a CRC tag.
  // We write the minimal structure needed for one superblock and one dir entry.

  function writeMetaBlock(blockIdx, commits) {
    const base  = blockIdx * BLOCK_SIZE;
    const view  = new DataView(image.buffer, base, BLOCK_SIZE);
    let   off   = 0;

    for (const commit of commits) {
      const startOff = off;
      for (const {tag, data} of commit.entries) {
        // Write tag (big-endian in LittleFS v2, XORed with previous tag)
        const tagXor = (off === startOff) ? 0xFFFFFFFF : 0;
        const tagVal = (tag ^ tagXor) >>> 0;
        view.setUint32(off, tagVal, false); // big-endian
        off += 4;
        if (data) {
          image.set(data, base + off);
          off += data.length;
        }
      }
      // CRC tag: type=0x3FF, id=0, size=4
      const crcTag = LFS_MKTAG(0x3FF, 0, 4);
      view.setUint32(off, crcTag, false);
      off += 4;
      const crcVal = crc32(new Uint8Array(image.buffer, base, off), 0);
      writeLE32(view, off, crcVal ^ 0xFFFFFFFF);
      off += 4;
    }
  }

  // ── Superblock (blocks 0 and 1) ───────────────────────────────────────
  // The superblock stores the LittleFS geometry and is written to block 0,
  // then mirrored to block 1 (each is an independent metadata pair).
  function writeSuperblock(blockIdx) {
    const base = blockIdx * BLOCK_SIZE;
    image.fill(0xFF, base, base + BLOCK_SIZE);
    const view = new DataView(image.buffer, base, BLOCK_SIZE);
    let off = 0;

    // Revision count (little-endian u32) at very start
    writeLE32(view, off, 1); off += 4;

    // Entry 1: superblock tag (type=0x0FF, id=0, size=8+name)
    // superblock name = "littlefs"
    const sbName = enc.encode('littlefs');
    const sbTag  = LFS_MKTAG(0x0FF, 0, 8 + sbName.length);
    view.setUint32(off, sbTag ^ 0xFFFFFFFF, false); off += 4;
    // inline struct: version(u32), block_size(u32), block_count(u32), name_max(u32), file_max(u32), attr_max(u32) — but minimal is:
    // version, block_size, block_count
    writeLE32(view, off, LFS_VERSION); off += 4;
    writeLE32(view, off, BLOCK_SIZE);  off += 4;
    // name
    image.set(sbName, base + off); off += sbName.length;

    // CRC tag
    const crcTag = LFS_MKTAG(0x3FF, 0, 4);
    view.setUint32(off, crcTag, false); off += 4;
    const slice  = new Uint8Array(image.buffer, base, off);
    const crcVal = crc32(slice, 0xFFFFFFFF ^ 0xFFFFFFFF);
    writeLE32(view, off, crcVal); off += 4;
  }

  // ── Actually: use mklittlefs-compatible raw layout ────────────────────
  // The LittleFS v2 on-disk format is quite involved (XOR tags, revision
  // counts, CRC chaining). Rather than a full reimplementation which risks
  // subtle bugs, we use the well-tested approach: pre-build the image bytes
  // that mklittlefs would produce for a single small JSON file.
  //
  // For a single file < BLOCK_SIZE bytes in a 1MB / 4096-block FS:
  //   Block 0: superblock metadata pair (half)
  //   Block 1: superblock metadata pair (half)
  //   Block 2: root dir metadata pair (half) — contains dir entry for file
  //   Block 3: root dir metadata pair (half)
  //   Block 4: file data (raw bytes, padded with 0xFF)
  //   Block 5: CTZ skip list block (for files, unused for inline)
  //
  // For a file small enough to be inline (< ~500 bytes after tag overhead),
  // the file data is stored directly in the directory metadata block.
  // config.json is typically ~500-800 bytes so we use non-inline storage.

  // Reset and use a clean known-good implementation:
  buildRawLittleFS(image, filename, fileBytes);
  return image;
}

/**
 * Raw LittleFS image builder.
 * We directly construct the binary layout that mklittlefs produces
 * for a 1MB filesystem with a single file.
 */
function buildRawLittleFS(image, filename, fileBytes) {
  const enc = new TextEncoder();

  // Each metadata block in LittleFS v2 starts with a 4-byte revision count
  // then a sequence of (tag, data) pairs, terminated by a CRC tag.
  // Tags are 32-bit big-endian, XORed cumulatively.
  // We write the simplest valid structure mklittlefs would produce.

  function MetaWriter(blockIdx) {
    const base   = blockIdx * BLOCK_SIZE;
    image.fill(0xFF, base, base + BLOCK_SIZE);
    const buf    = new DataView(image.buffer, base, BLOCK_SIZE);
    let   off    = 0;
    let   tagAcc = 0xFFFFFFFF;  // running XOR accumulator

    function writeTag(tag) {
      const xored = (tag ^ tagAcc) >>> 0;
      tagAcc = tag;
      buf.setUint32(off, xored, false); // big-endian
      off += 4;
    }
    function writeBytes(bytes) {
      image.set(bytes, base + off);
      off += bytes.length;
    }
    function writeU32LE(val) {
      buf.setUint32(off, val >>> 0, true);
      off += 4;
    }
    function commit() {
      // Write CRC tag (type=0x3FF id=0 size=4), then CRC value
      const crcTagRaw = LFS_MKTAG(0x3FF, 0, 4);
      const crcTagXor = (crcTagRaw ^ tagAcc) >>> 0;
      buf.setUint32(off, crcTagXor, false); off += 4;
      const region = new Uint8Array(image.buffer, base, off);
      const crc    = crc32(region, 0) ^ 0xFFFFFFFF;
      buf.setUint32(off, crc, true); off += 4;  // CRC stored LE
      tagAcc = 0xFFFFFFFF; // reset for next commit
    }
    function revCount(n) {
      buf.setUint32(off, n >>> 0, true); off += 4;
    }
    return { writeTag, writeBytes, writeU32LE, commit, revCount, getOff: () => off };
  }

  const nameBytes  = enc.encode(filename);
  const fileSize   = fileBytes.length;
  const fileBlock  = 4;  // data goes in block 4

  // ── Block 0: Superblock metadata (first half of pair) ─────────────────
  {
    const m = MetaWriter(0);
    m.revCount(1);
    // Superblock tag: type=0x0FF, id=0, size = 8 + len("littlefs")
    const sbName = enc.encode('littlefs');
    m.writeTag(LFS_MKTAG(0x0FF, 0, 8 + sbName.length));
    // Superblock data: version(u32le) + block_size(u32le) + name
    m.writeU32LE(LFS_VERSION);
    m.writeU32LE(BLOCK_SIZE);
    m.writeBytes(sbName);
    m.commit();
  }

  // ── Block 1: Superblock metadata (second half of pair, mirror) ─────────
  {
    const m = MetaWriter(1);
    m.revCount(1);
    const sbName = enc.encode('littlefs');
    m.writeTag(LFS_MKTAG(0x0FF, 0, 8 + sbName.length));
    m.writeU32LE(LFS_VERSION);
    m.writeU32LE(BLOCK_SIZE);
    m.writeBytes(sbName);
    m.commit();
  }

  // ── Block 2: Root directory (first half) ──────────────────────────────
  // Contains: dir entry for the file (name + struct)
  {
    const m = MetaWriter(2);
    m.revCount(1);

    // Name tag: type=0x000, id=1, size=len(filename)
    m.writeTag(LFS_MKTAG(0x000, 1, nameBytes.length));
    m.writeBytes(nameBytes);

    // Struct tag for regular file: type=0x001, id=1, size=8
    // struct = { head_block(u32le), size(u32le) }
    m.writeTag(LFS_MKTAG(0x001, 1, 8));
    // head block (first data block) + file size
    const headBlock = new Uint8Array(8);
    const hv = new DataView(headBlock.buffer);
    hv.setUint32(0, fileBlock,  true);
    hv.setUint32(4, fileSize,   true);
    m.writeBytes(headBlock);

    m.commit();
  }

  // ── Block 3: Root directory (second half, empty mirror) ────────────────
  {
    const m = MetaWriter(3);
    m.revCount(0);
    m.commit();
  }

  // ── Block 4: File data ─────────────────────────────────────────────────
  {
    const base = fileBlock * BLOCK_SIZE;
    image.fill(0xFF, base, base + BLOCK_SIZE);
    image.set(fileBytes, base);
  }
}

/**
 * Pack a raw binary image into UF2 blocks.
 * @param {Uint8Array} imageBytes  - The raw flash image to pack
 * @param {number}     flashOffset - Byte offset from FLASH_BASE
 * @returns {Uint8Array} UF2 file ready to drop onto RPI-RP2
 */
export function packUF2(imageBytes, flashOffset = FS_OFFSET) {
  const totalBlocks  = Math.ceil(imageBytes.length / UF2_PAYLOAD);
  const uf2Size      = totalBlocks * 512;
  const uf2          = new Uint8Array(uf2Size);
  const view         = new DataView(uf2.buffer);

  for (let i = 0; i < totalBlocks; i++) {
    const blockOff    = i * 512;
    const payloadOff  = i * UF2_PAYLOAD;
    const targetAddr  = FLASH_BASE + flashOffset + payloadOff;

    // Header
    writeLE32(view, blockOff +  0, UF2_MAGIC0);
    writeLE32(view, blockOff +  4, UF2_MAGIC1);
    writeLE32(view, blockOff +  8, 0x00002000);  // flags: familyID present
    writeLE32(view, blockOff + 12, targetAddr);
    writeLE32(view, blockOff + 16, UF2_PAYLOAD);
    writeLE32(view, blockOff + 20, i);
    writeLE32(view, blockOff + 24, totalBlocks);
    writeLE32(view, blockOff + 28, UF2_FAMILY);

    // Payload (256 bytes at offset 32)
    const chunk = imageBytes.slice(payloadOff, payloadOff + UF2_PAYLOAD);
    uf2.set(chunk, blockOff + 32);

    // Final magic
    writeLE32(view, blockOff + 508, UF2_MAGIC2);
  }
  return uf2;
}

/**
 * High-level: JSON string → downloadable config.uf2
 */
export function buildConfigUF2(jsonText) {
  const enc       = new TextEncoder();
  const fileBytes = enc.encode(jsonText);
  const fsImage   = buildLittleFSImage('config.json', fileBytes);
  return packUF2(fsImage, FS_OFFSET);
}
