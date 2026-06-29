/**
 * patch-uf2.js
 *
 * Patches placeholder strings directly in the firmware UF2 binary.
 * No LittleFS needed — user info is baked into the firmware itself.
 *
 * The firmware has fixed-length char arrays in the Config struct:
 *   firstname[48]    → "IOTWX_FIRSTNAME_PLACEHOLDER_____"
 *   lastname[48]     → "IOTWX_LASTNAME_PLACEHOLDER______"
 *   email[64]        → "IOTWX_EMAIL_PLACEHOLDER_________________________"
 *   organization[64] → "IOTWX_ORGANIZATION_PLACEHOLDER__________________"
 *
 * We find each placeholder in the UF2 payload bytes and overwrite
 * with the user's value, null-padded to the same fixed length.
 * The array sizes in the firmware must be >= the placeholder lengths.
 */

const PLACEHOLDERS = {
  firstname:    { marker: 'IOTWX_FIRSTNAME_PLACEHOLDER_____',              maxLen: 48 },
  lastname:     { marker: 'IOTWX_LASTNAME_PLACEHOLDER______',              maxLen: 48 },
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
 * Find a ASCII string in the UF2 payload bytes (offset 32-287 of each block).
 * Returns the absolute byte offset in the u8 array, or -1 if not found.
 */
function findInPayloads(u8, searchStr) {
  const enc     = new TextEncoder();
  const needle  = enc.encode(searchStr);
  const blocks  = u8.length / 512;

  for (let i = 0; i < blocks; i++) {
    const payloadStart = i * 512 + 32;
    const payloadEnd   = i * 512 + 288;

    // Search within this payload for the start of the needle
    outer: for (let pos = payloadStart; pos <= payloadEnd - needle.length; pos++) {
      for (let j = 0; j < needle.length; j++) {
        if (u8[pos + j] !== needle[j]) continue outer;
      }
      return pos;
    }
  }
  return -1;
}

/**
 * Patch a placeholder in the firmware UF2 with the user's value.
 * Writes the value null-padded to maxLen bytes into the payload.
 * Handles the case where the string spans two consecutive payload slots.
 */
function patchPlaceholder(u8, field, value, placeholder, maxLen) {
  const enc       = new TextEncoder();
  const valueBytes = enc.encode(value);

  if (valueBytes.length >= maxLen) {
    throw new Error(
      `${field} value "${value}" is ${valueBytes.length} chars — max is ${maxLen - 1}.`
    );
  }

  // Build the replacement: value + null terminator + zeros to fill maxLen
  const replacement = new Uint8Array(maxLen); // all zeros
  replacement.set(valueBytes);                 // copy value, rest stays 0

  // Find placeholder start in payload regions
  const startPos = findInPayloads(u8, placeholder);
  if (startPos === -1) {
    throw new Error(
      `Could not find placeholder for "${field}" in firmware. ` +
      `Make sure you compiled the latest version with char array fields.`
    );
  }

  // Write replacement bytes — may span across payload boundaries
  // Each payload is at bytes [i*512+32 .. i*512+287] within each UF2 block
  let written = 0;
  let filePos  = startPos;

  while (written < maxLen) {
    // Which UF2 block and offset within it?
    const block      = Math.floor(filePos / 512);
    const inBlock    = filePos % 512;

    if (inBlock < 32 || inBlock >= 288) {
      // We've wandered out of payload — skip to next payload
      const nextPayloadStart = block * 512 + 32;
      const nextBlock = (block + 1) * 512 + 32;
      filePos = (inBlock < 32) ? nextPayloadStart : nextBlock;
      continue;
    }

    u8[filePos] = replacement[written];
    written++;
    filePos++;
  }
}

/**
 * Patch the firmware UF2 with user config values.
 * Returns patched ArrayBuffer.
 */
function patchFirmwareUF2(fwBuf, configObj) {
  const u8 = new Uint8Array(fwBuf.slice(0)); // own copy
  validateUF2(u8, 'firmware');

  for (const [field, { marker, maxLen }] of Object.entries(PLACEHOLDERS)) {
    const value = String(configObj?.station_info?.[field] ?? '');
    patchPlaceholder(u8, field, value, marker, maxLen);
  }

  return u8.buffer;
}

/**
 * Combine firmware + config template UF2 blocks into one.
 * Renumbers seq and total in every block.
 * (Config template provides LittleFS FS partition — optional but included
 *  so a fresh board gets a valid FS even without a separate config flash.)
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
 * Main entry: fetch firmware, patch user config into it, combine with
 * config_template for a valid LittleFS partition, return combined UF2.
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

  // Patch user info into firmware binary
  const patchedFwBuf = patchFirmwareUF2(fwBuf, configObj);
  const patchedFwU8  = new Uint8Array(patchedFwBuf);
  const cfgU8        = new Uint8Array(cfgBuf);

  validateUF2(cfgU8, 'config template');

  return combineAndRenumber(patchedFwU8, cfgU8);
}
