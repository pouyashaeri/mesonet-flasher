/**
 * patch-uf2.js
 *
 * Builds a single combined .uf2 that flashes BOTH firmware AND config
 * in one drag-and-drop operation:
 *
 *   [firmware blocks] + [config blocks (patched with user JSON)]
 *
 * Flash map (Adafruit Feather RP2040, 8MB):
 *   0x10000000 – 0x10700000  firmware  (7MB sketch)
 *   0x10700000 – 0x10800000  LittleFS  (1MB, contains /config.json)
 *
 * The config template is a pre-built LittleFS image with /config.json
 * padded to exactly FIXED_JSON_SIZE bytes.  We find the JSON in the
 * template and overwrite it with the user's JSON (same fixed length).
 * No CRC recalculation is needed.
 *
 * After patching, all UF2 block sequence numbers and total-block counts
 * are renumbered so the RP2040 bootloader accepts the combined file.
 */

const FIXED_JSON_SIZE = 2048;   // must match config_template.uf2
const UF2_MAGIC0      = 0x0A324655;
const UF2_MAGIC1      = 0x9E5D5157;
const UF2_MAGIC2      = 0x0AB16F30;

/**
 * Parse a UF2 file into an array of 512-byte DataView blocks.
 * Validates magic bytes; throws on malformed input.
 */
function parseUF2(buf) {
  const u8     = new Uint8Array(buf);
  const blocks = [];
  for (let i = 0; i + 512 <= u8.length; i += 512) {
    const view = new DataView(buf, i, 512);
    if (view.getUint32(0, true) !== UF2_MAGIC0 ||
        view.getUint32(4, true) !== UF2_MAGIC1 ||
        view.getUint32(508, true) !== UF2_MAGIC2) {
      throw new Error(`Invalid UF2 magic at block offset ${i}`);
    }
    blocks.push(view);
  }
  return blocks;
}

/**
 * Patch the JSON payload inside the config UF2 blocks.
 * Returns a new ArrayBuffer with the JSON replaced.
 */
function patchConfigUF2(cfgBuf, configObj) {
  const jsonText = JSON.stringify(configObj, null, 2);
  if (jsonText.length > FIXED_JSON_SIZE) {
    throw new Error(
      `Config JSON is ${jsonText.length} bytes — max is ${FIXED_JSON_SIZE}. ` +
      `Shorten your field values.`
    );
  }

  // Copy the buffer so we don't mutate the fetched cache
  const patched  = buf => new Uint8Array(buf.slice(0));
  const u8       = new Uint8Array(cfgBuf.slice(0));
  const enc      = new TextEncoder();
  const newBytes = enc.encode(jsonText.padEnd(FIXED_JSON_SIZE, ' '));

  // Find the JSON start: locate the opening '{' that begins our padded block.
  // The template JSON starts with "{\n  \"radio\"" — search for that signature.
  const marker   = enc.encode('{\n  "radio"');
  let jsonOffset = -1;
  outer: for (let i = 0; i < u8.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (u8[i + j] !== marker[j]) continue outer;
    }
    jsonOffset = i;
    break;
  }
  if (jsonOffset === -1) throw new Error('Could not locate JSON in config template.');

  // Write new JSON bytes
  for (let i = 0; i < FIXED_JSON_SIZE; i++) {
    u8[jsonOffset + i] = newBytes[i];
  }
  return u8.buffer;
}

/**
 * Combine firmware + patched-config UF2 blocks into one ArrayBuffer.
 * Renumbers all block sequence numbers and total-block counts.
 */
function combineUF2(fwBuf, cfgBuf) {
  const fwBlocks  = parseUF2(fwBuf);
  const cfgBlocks = parseUF2(cfgBuf);
  const total     = fwBlocks.length + cfgBlocks.length;
  const out       = new ArrayBuffer(total * 512);
  const outU8     = new Uint8Array(out);
  let   seq       = 0;

  for (const src of [...fwBlocks, ...cfgBlocks]) {
    const srcU8  = new Uint8Array(src.buffer, src.byteOffset, 512);
    const dstOff = seq * 512;
    outU8.set(srcU8, dstOff);
    // Patch block_seq (offset 20) and num_blocks (offset 24)
    const view = new DataView(out, dstOff, 512);
    view.setUint32(20, seq,   true);
    view.setUint32(24, total, true);
    seq++;
  }
  return out;
}

/**
 * High-level: fetch firmware + config template, patch JSON, combine.
 *
 * @param {object} configObj     - User config (from config.html form)
 * @param {string} firmwareUrl   - URL of mesonet_rp2040.uf2
 * @param {string} templateUrl   - URL of config_template.uf2
 * @returns {ArrayBuffer}        - Combined .uf2 ready to drag onto RPI-RP2
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
  if (!fwResp.ok)  throw new Error(`Could not fetch firmware: ${firmwareUrl} (${fwResp.status})`);
  if (!cfgResp.ok) throw new Error(`Could not fetch config template: ${templateUrl} (${cfgResp.status})`);

  const [fwBuf, cfgBuf] = await Promise.all([
    fwResp.arrayBuffer(),
    cfgResp.arrayBuffer(),
  ]);

  const patchedCfg = patchConfigUF2(cfgBuf, configObj);
  return combineUF2(fwBuf, patchedCfg);
}
