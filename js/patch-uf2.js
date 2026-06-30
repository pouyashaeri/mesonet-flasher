/**
 * patch-uf2.js
 *
 * Patches placeholder strings directly in the firmware UF2 binary.
 * Handles placeholders that span across UF2 payload/header boundaries.
 *
 * Strategy: extract all payload bytes into a flat virtual buffer,
 * search there, then write back using a payload-offset → file-offset map.
 */

const PLACEHOLDERS = {
  firstname:    { marker: 'IOTWX_FIRSTNAME_PLACEHOLDER_____',               maxLen: 48 },
  lastname:     { marker: 'IOTWX_LASTNAME_PLACEHOLDER______',               maxLen: 48 },
  email:        { marker: 'IOTWX_EMAIL_PLACEHOLDER_________________________', maxLen: 64 },
  organization: { marker: 'IOTWX_ORGANIZATION_PLACEHOLDER__________________', maxLen: 64 },
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
 * Build a virtual flat buffer of all payload bytes,
 * plus a map from virtual offset → file offset.
 * This lets us search linearly across payload regions
 * even when the data is split by UF2 headers.
 */
function buildPayloadView(u8) {
  const blocks   = u8.length / 512;
  const virtual  = new Uint8Array(blocks * 256); // 256 payload bytes per block
  const fileMap  = new Int32Array(blocks * 256); // virtual[i] lives at u8[fileMap[i]]

  for (let i = 0; i < blocks; i++) {
    const payloadStart = i * 512 + 32;
    for (let j = 0; j < 256; j++) {
      const virt = i * 256 + j;
      virtual[virt]  = u8[payloadStart + j];
      fileMap[virt]  = payloadStart + j;
    }
  }
  return { virtual, fileMap };
}

/**
 * Find a marker string in the virtual payload buffer.
 * Returns virtual offset or -1.
 */
function findInVirtual(virtual, markerStr) {
  const enc    = new TextEncoder();
  const needle = enc.encode(markerStr);

  outer: for (let i = 0; i <= virtual.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (virtual[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Patch a single placeholder field in the firmware.
 */
function patchPlaceholder(u8, virtual, fileMap, field, value, marker, maxLen) {
  const enc        = new TextEncoder();
  const valueBytes = enc.encode(value);

  if (valueBytes.length >= maxLen) {
    throw new Error(`${field} "${value}" is ${valueBytes.length} chars — max is ${maxLen - 1}.`);
  }

  const virtStart = findInVirtual(virtual, marker);
  if (virtStart === -1) {
    throw new Error(
      `Could not find placeholder for "${field}" in firmware.\n` +
      `Make sure you compiled the latest .ino with char array fields.`
    );
  }

  // Build replacement: value + null padding to maxLen
  const replacement = new Uint8Array(maxLen); // zeroed
  replacement.set(valueBytes);

  // Write replacement bytes using fileMap to handle cross-boundary writes
  for (let i = 0; i < maxLen; i++) {
    const fileOffset = fileMap[virtStart + i];
    u8[fileOffset]   = replacement[i];
    virtual[virtStart + i] = replacement[i]; // keep virtual in sync
  }
}

/**
 * Patch all placeholder fields in the firmware UF2.
 */
function patchFirmwareUF2(fwBuf, configObj) {
  const u8 = new Uint8Array(fwBuf.slice(0));
  validateUF2(u8, 'firmware');

  const { virtual, fileMap } = buildPayloadView(u8);

  for (const [field, { marker, maxLen }] of Object.entries(PLACEHOLDERS)) {
    const value = String(configObj?.station_info?.[field] ?? '');
    patchPlaceholder(u8, virtual, fileMap, field, value, marker, maxLen);
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
