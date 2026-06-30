/**
 * patch-uf2.js
 *
 * Patches placeholder strings directly in the firmware UF2 binary.
 *
 * Strategy: search raw file bytes for the placeholder prefix (the part
 * that fits before any block boundary), then write replacement bytes
 * at those raw positions — but ONLY to payload slots (inBlk 32-287).
 * Any replacement bytes that would fall in header (0-31) or padding
 * (288-511) regions are written to the NEXT block's payload instead,
 * by following the flash address sequence.
 */

const PLACEHOLDERS = {
  firstname:    { marker: 'IOTWXFNAME0000000000000000000000',               maxLen: 48 },
  lastname:     { marker: 'IOTWXLNAME1111111111111111111111',               maxLen: 48 },
  email:        { marker: 'IOTWXEMAIL22222222222222222222222222222222222222', maxLen: 64 },
  organization: { marker: 'IOTWXORGS3333333333333333333333333333333333333333', maxLen: 64 },
};

const UF2_MAGIC0 = 0x0A324655;
const UF2_MAGIC1 = 0x9E5D5157;
const UF2_MAGIC2 = 0x0AB16F30;

function readU32LE(u8, off) {
  return (u8[off] | (u8[off+1]<<8) | (u8[off+2]<<16) | (u8[off+3]<<24)) >>> 0;
}
function writeU32LE(u8, off, val) {
  val = val >>> 0;
  u8[off]   =  val        & 0xFF;
  u8[off+1] = (val >>  8) & 0xFF;
  u8[off+2] = (val >> 16) & 0xFF;
  u8[off+3] = (val >> 24) & 0xFF;
}

function validateUF2(u8, label) {
  if (u8.length % 512 !== 0)
    throw new Error(`${label}: length ${u8.length} not a multiple of 512`);
  const blocks = u8.length / 512;
  for (let i = 0; i < blocks; i++) {
    const b = i * 512;
    if (readU32LE(u8, b)     !== UF2_MAGIC0 ||
        readU32LE(u8, b + 4) !== UF2_MAGIC1 ||
        readU32LE(u8, b+508) !== UF2_MAGIC2) {
      throw new Error(`${label}: bad UF2 magic at block ${i}`);
    }
  }
  return blocks;
}

/**
 * Build a map from flash address → file offset, using the target address
 * field in each UF2 block header. This is the definitive way to find
 * where any flash byte lives in the file.
 * 
 * Each block carries 256 bytes at [targetAddr .. targetAddr+255].
 * File payload bytes are at [blockStart+32 .. blockStart+287].
 */
function buildAddressMap(u8) {
  const blocks = u8.length / 512;
  // Map: flashAddr → fileOffset
  const map = new Map();
  for (let i = 0; i < blocks; i++) {
    const base        = i * 512;
    const targetAddr  = readU32LE(u8, base + 12);
    for (let j = 0; j < 256; j++) {
      map.set(targetAddr + j, base + 32 + j);
    }
  }
  return map;
}

/**
 * Find the flash address where a marker string starts.
 * Searches by reconstructing flash content from the address map.
 * This works even when the string spans block boundaries, because
 * flash addresses are contiguous even if file offsets are not.
 */
function findMarkerInFlash(u8, addrMap, markerStr) {
  const enc    = new TextEncoder();
  const needle = enc.encode(markerStr);

  // Get all flash addresses covered by this UF2, sorted
  const addrs = [...addrMap.keys()].sort((a, b) => a - b);

  outer: for (let ai = 0; ai <= addrs.length - needle.length; ai++) {
    // Check if needle matches starting at addrs[ai]
    // Addresses must be contiguous for a match
    for (let j = 0; j < needle.length; j++) {
      const addr = addrs[ai] + j;
      if (!addrMap.has(addr)) continue outer;
      const fileOff = addrMap.get(addr);
      if (u8[fileOff] !== needle[j]) continue outer;
    }
    return addrs[ai]; // flash address where marker starts
  }
  return -1;
}

/**
 * Patch a placeholder by flash address, writing replacement bytes
 * to the correct file offsets via the address map.
 */
function patchByFlashAddress(u8, addrMap, field, value, marker, maxLen) {
  const enc        = new TextEncoder();
  const valueBytes = enc.encode(value);

  if (valueBytes.length >= maxLen) {
    throw new Error(`${field} "${value}" is ${valueBytes.length} chars — max is ${maxLen - 1}.`);
  }

  const startFlashAddr = findMarkerInFlash(u8, addrMap, marker);
  if (startFlashAddr === -1) {
    throw new Error(
      `Could not find placeholder for "${field}" in firmware.\n` +
      `Make sure you compiled the latest .ino with char array fields.`
    );
  }

  // Build replacement: value + null padding to maxLen
  const replacement = new Uint8Array(maxLen); // zeroed
  replacement.set(valueBytes);

  // Write each byte to its file offset via the address map
  for (let i = 0; i < maxLen; i++) {
    const flashAddr = startFlashAddr + i;
    const fileOff   = addrMap.get(flashAddr);
    if (fileOff === undefined) {
      throw new Error(`Flash address 0x${flashAddr.toString(16)} not in UF2 map for field "${field}"`);
    }
    u8[fileOff] = replacement[i];
  }
}

/**
 * Patch all placeholder fields in the firmware UF2.
 */
function patchFirmwareUF2(fwBuf, configObj) {
  const u8 = new Uint8Array(fwBuf.slice(0));
  validateUF2(u8, 'firmware');

  const addrMap = buildAddressMap(u8);

  for (const [field, { marker, maxLen }] of Object.entries(PLACEHOLDERS)) {
    const value = String(configObj?.station_info?.[field] ?? '');
    patchByFlashAddress(u8, addrMap, field, value, marker, maxLen);
  }

  return u8.buffer;
}

/**
 * Combine firmware + config template into one UF2, renumber all blocks.
 */
function combineAndRenumber(fwU8, cfgU8) {
  const fwBlocks  = fwU8.length  / 512;
  const cfgBlocks = cfgU8.length / 512;
  const total     = fwBlocks + cfgBlocks;
  const out       = new Uint8Array(total * 512);
  out.set(fwU8,  0);
  out.set(cfgU8, fwBlocks * 512);
  for (let i = 0; i < total; i++) {
    const b = i * 512;
    writeU32LE(out, b + 20, i);
    writeU32LE(out, b + 24, total);
  }
  return out.buffer;
}

/**
 * Main entry: fetch firmware + config template, patch user info, combine.
 */
export async function buildCombinedUF2(
  configObj,
  firmwareUrl = 'firmware/mesonet_rp2040.uf2',
  templateUrl = 'firmware/config_template.uf2'
) {
  const [fwResp, cfgResp] = await Promise.all([
    fetch(firmwareUrl),
    fetch(templateUrl),
  ]);
  if (!fwResp.ok)  throw new Error(`Firmware not found (${fwResp.status}): ${firmwareUrl}`);
  if (!cfgResp.ok) throw new Error(`Config template not found (${cfgResp.status}): ${templateUrl}`);

  const [fwBuf, cfgBuf] = await Promise.all([
    fwResp.arrayBuffer(),
    cfgResp.arrayBuffer(),
  ]);

  const patchedFwBuf = patchFirmwareUF2(fwBuf, configObj);
  const patchedFwU8  = new Uint8Array(patchedFwBuf);
  const cfgU8        = new Uint8Array(cfgBuf);

  validateUF2(cfgU8, 'config template');

  return combineAndRenumber(patchedFwU8, cfgU8);
}
