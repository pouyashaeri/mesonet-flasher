/**
 * patch-uf2.js
 *
 * Builds a single combined .uf2 containing firmware + LittleFS config.
 *
 * UF2 block layout (512 bytes each):
 *   [0:32]   header  (magic, flags, addr, payload_size, seq, total, family)
 *   [32:288] payload (256 bytes of flash data)
 *   [288:508] zero padding
 *   [508:512] final magic (0x0AB16F30)
 *
 * CRITICAL: JSON must be written payload-slot by payload-slot (256 bytes
 * at a time), skipping the 256-byte header+padding+magic gap between slots.
 * Writing linearly overwrites the final magic bytes and corrupts the file.
 */

const FIXED_JSON_SIZE = 2048;   // must match config_template.uf2 generation
const UF2_MAGIC0      = 0x0A324655;
const UF2_MAGIC1      = 0x9E5D5157;
const UF2_MAGIC2      = 0x0AB16F30;

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
      throw new Error(
        `${label}: bad UF2 magic at block ${i} (file offset ${b})\n` +
        `  magic0=0x${readU32LE(u8,b).toString(16).padStart(8,'0')} ` +
        `magic2=0x${readU32LE(u8,b+508).toString(16).padStart(8,'0')}`
      );
    }
  }
  return blocks;
}

/**
 * Patch JSON into the config template.
 * Writes 256 bytes at a time into consecutive UF2 payload slots,
 * skipping headers, padding, and final magic.
 */
function patchConfigUF2(u8, configObj) {
  const jsonText = JSON.stringify(configObj, null, 2);
  if (jsonText.length > FIXED_JSON_SIZE)
    throw new Error(`Config JSON is ${jsonText.length} bytes — max is ${FIXED_JSON_SIZE}.`);

  const enc      = new TextEncoder();
  const newBytes = enc.encode(jsonText.padEnd(FIXED_JSON_SIZE, ' ')); // exactly 2048 bytes

  // Find the first UF2 block whose payload starts with our JSON signature
  const marker = enc.encode('{\n  "radio"');
  let startBlock = -1;
  const blocks = u8.length / 512;
  outer: for (let i = 0; i < blocks; i++) {
    const payloadStart = i * 512 + 32;
    for (let j = 0; j < marker.length; j++) {
      if (u8[payloadStart + j] !== marker[j]) continue outer;
    }
    startBlock = i;
    break;
  }
  if (startBlock === -1)
    throw new Error('Could not find JSON in config template — is firmware/config_template.uf2 correct?');

  // Write 256 bytes per block into payload slots only
  // FIXED_JSON_SIZE=2048 = exactly 8 blocks × 256 bytes
  for (let slot = 0; slot < FIXED_JSON_SIZE / 256; slot++) {
    const fileOffset  = (startBlock + slot) * 512 + 32;  // payload start of each block
    const jsonOffset  = slot * 256;
    u8.set(newBytes.subarray(jsonOffset, jsonOffset + 256), fileOffset);
  }
}

/**
 * Concatenate firmware + patched config blocks, renumber seq and total in each.
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
    writeU32LE(out, b + 20, i);      // block_seq
    writeU32LE(out, b + 24, total);  // num_blocks
  }
  return out.buffer;
}

/**
 * Main entry: fetch firmware + template, patch JSON, return combined UF2.
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

  const fwU8  = new Uint8Array(fwBuf);
  const cfgU8 = new Uint8Array(cfgBuf.slice(0)); // own copy — we mutate it

  validateUF2(fwU8,  'firmware');
  validateUF2(cfgU8, 'config template');

  patchConfigUF2(cfgU8, configObj);

  // Validate config is still intact after patch
  validateUF2(cfgU8, 'patched config');

  return combineAndRenumber(fwU8, cfgU8);
}
