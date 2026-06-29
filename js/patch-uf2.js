/**
 * patch-uf2.js
 *
 * Builds a single combined .uf2 that flashes BOTH firmware AND config
 * in one drag-and-drop:
 *
 *   [firmware blocks] + [config blocks with user JSON patched in]
 *
 * Flash map (Adafruit Feather RP2040, 8MB):
 *   0x10000000 – 0x10700000  firmware  (7MB sketch)
 *   0x10700000 – 0x10800000  LittleFS  (1MB, contains /config.json)
 *
 * The config template has /config.json padded to exactly FIXED_JSON_SIZE
 * bytes. We locate that JSON in the binary and overwrite it in-place —
 * same fixed length means no LittleFS metadata or CRC needs updating.
 *
 * After patching, all UF2 block sequence numbers and total-block counts
 * are renumbered so the bootloader accepts the combined file.
 */

const FIXED_JSON_SIZE = 2048;
const UF2_MAGIC0      = 0x0A324655;
const UF2_MAGIC1      = 0x9E5D5157;
const UF2_MAGIC2      = 0x0AB16F30;

/** Read a little-endian u32 from a Uint8Array at a given offset. */
function readU32(u8, off) {
  return (u8[off] | (u8[off+1]<<8) | (u8[off+2]<<16) | (u8[off+3]<<24)) >>> 0;
}

/** Write a little-endian u32 into a Uint8Array at a given offset. */
function writeU32(u8, off, val) {
  val = val >>> 0;
  u8[off]   =  val        & 0xFF;
  u8[off+1] = (val >>  8) & 0xFF;
  u8[off+2] = (val >> 16) & 0xFF;
  u8[off+3] = (val >> 24) & 0xFF;
}

/**
 * Validate that a buffer looks like a UF2 file.
 * Returns the number of blocks.
 */
function validateUF2(u8, label) {
  if (u8.length % 512 !== 0) {
    throw new Error(`${label}: size ${u8.length} is not a multiple of 512`);
  }
  const blocks = u8.length / 512;
  for (let i = 0; i < blocks; i++) {
    const base = i * 512;
    const m0 = readU32(u8, base);
    const m1 = readU32(u8, base + 4);
    const m2 = readU32(u8, base + 508);
    if (m0 !== UF2_MAGIC0 || m1 !== UF2_MAGIC1 || m2 !== UF2_MAGIC2) {
      throw new Error(
        `${label}: invalid UF2 magic at block ${i} (offset ${base})\n` +
        `  magic0=0x${m0.toString(16).padStart(8,'0')} ` +
        `magic1=0x${m1.toString(16).padStart(8,'0')} ` +
        `magic2=0x${m2.toString(16).padStart(8,'0')}`
      );
    }
  }
  return blocks;
}

/**
 * Patch the JSON payload inside the config template UF2.
 * Finds the JSON by searching for its opening signature and
 * overwrites exactly FIXED_JSON_SIZE bytes with the new JSON
 * (space-padded to the same length).
 */
function patchConfigUF2(u8, configObj) {
  const jsonText = JSON.stringify(configObj, null, 2);
  if (jsonText.length > FIXED_JSON_SIZE) {
    throw new Error(
      `Config JSON is ${jsonText.length} bytes — max is ${FIXED_JSON_SIZE}. ` +
      `Shorten your field values.`
    );
  }
  const padded  = jsonText.padEnd(FIXED_JSON_SIZE, ' ');
  const enc     = new TextEncoder();
  const newBytes = enc.encode(padded);  // exactly FIXED_JSON_SIZE bytes

  // Locate the JSON: search for the opening signature '{\n  "radio"'
  const marker    = enc.encode('{\n  "radio"');
  let   jsonOffset = -1;
  outer: for (let i = 0; i < u8.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (u8[i + j] !== marker[j]) continue outer;
    }
    jsonOffset = i;
    break;
  }
  if (jsonOffset === -1) {
    throw new Error('Could not find JSON payload in config template. Is firmware/config_template.uf2 correct?');
  }

  // Overwrite in-place
  u8.set(newBytes, jsonOffset);
}

/**
 * Combine firmware + patched config into one UF2.
 * Renumbers block_seq (offset 20) and num_blocks (offset 24) in every block.
 */
function combineAndRenumber(fwU8, cfgU8) {
  const fwBlocks  = fwU8.length  / 512;
  const cfgBlocks = cfgU8.length / 512;
  const total     = fwBlocks + cfgBlocks;
  const out       = new Uint8Array(total * 512);

  out.set(fwU8,  0);
  out.set(cfgU8, fwBlocks * 512);

  for (let i = 0; i < total; i++) {
    const base = i * 512;
    writeU32(out, base + 20, i);      // block_seq
    writeU32(out, base + 24, total);  // num_blocks
  }
  return out.buffer;
}

/**
 * High-level entry point.
 * Fetches firmware + config template, patches the JSON, returns combined UF2.
 *
 * @param {object} configObj   - User config built on config.html
 * @param {string} firmwareUrl - URL of mesonet_rp2040.uf2
 * @param {string} templateUrl - URL of config_template.uf2
 * @returns {ArrayBuffer}      - Combined .uf2 ready to drag onto RPI-RP2
 */
export async function buildCombinedUF2(
  configObj,
  firmwareUrl = 'firmware/mesonet_rp2040.uf2',
  templateUrl = 'firmware/config_template.uf2'
) {
  // Fetch both files in parallel
  const [fwResp, cfgResp] = await Promise.all([
    fetch(firmwareUrl),
    fetch(templateUrl),
  ]);
  if (!fwResp.ok)  throw new Error(`Could not fetch firmware (${fwResp.status}): ${firmwareUrl}`);
  if (!cfgResp.ok) throw new Error(`Could not fetch config template (${cfgResp.status}): ${templateUrl}`);

  const [fwBuf, cfgBuf] = await Promise.all([
    fwResp.arrayBuffer(),
    cfgResp.arrayBuffer(),
  ]);

  // Work with Uint8Arrays — avoids DataView byteOffset pitfalls
  const fwU8  = new Uint8Array(fwBuf);
  const cfgU8 = new Uint8Array(cfgBuf.slice(0)); // slice = own copy so we can mutate

  // Validate both files
  validateUF2(fwU8,  'firmware');
  validateUF2(cfgU8, 'config template');

  // Patch JSON into config template (mutates cfgU8 in-place)
  patchConfigUF2(cfgU8, configObj);

  // Combine and renumber
  return combineAndRenumber(fwU8, cfgU8);
}
