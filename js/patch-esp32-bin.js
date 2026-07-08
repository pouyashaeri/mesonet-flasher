/**
 * patch-esp32-bin.js — direct marker patching for a flat ESP32 .bin
 *
 * Unlike UF2 (which stores data in 512-byte blocks with a 32-byte header
 * per block), a compiled ESP32 .bin is one contiguous blob whose bytes map
 * 1:1 to flash offsets (relative to wherever esptool writes it). That means
 * patching is just: find the marker string, overwrite it with the real
 * value + a null terminator. No address-map reconstruction needed.
 *
 * IMPORTANT: these marker strings and maxLen values MUST exactly match the
 * buffer declarations in the .ino sketch. If you resize a buffer in the
 * sketch, update maxLen here too, then re-export the .bin.
 */

const PLACEHOLDERS = {
  id:                { marker: 'IOTWXID__PLACEHOLDER_000000000000000000000000',                        maxLen: 48 },
  wifi_ssid:         { marker: 'IOTWXSSID_PLACEHOLDER_00000000000000000000000',                         maxLen: 48 },
  wifi_pwd:          { marker: 'IOTWXPWD__PLACEHOLDER_0000000000000000000000000000000000000000',        maxLen: 64 },
  mq_ip:             { marker: 'IOTWXMQIP__PLACEHOLDER_000000000000000000000000000000000000000',        maxLen: 64 },
  topic:             { marker: 'IOTWXTOPIC_PLACEHOLDER_0000000000000000000000000000000000000000000000000000', maxLen: 96 },
  mq_port:           { marker: '1883\0\0\0',    maxLen: 8, isNumeric: true, defaultValue: '1883' },
  gpio_config:       { marker: 'A\0\0',         maxLen: 4, isNumeric: true, defaultValue: 'A' },
  use_wifi:          { marker: '1\0\0',         maxLen: 4, isNumeric: true, defaultValue: '1' },
  publish_interval:  { marker: '2\0\0\0\0\0\0', maxLen: 8, isNumeric: true, defaultValue: '2' },
  reset_interval:    { marker: '360\0\0\0\0',   maxLen: 8, isNumeric: true, defaultValue: '360' },
  timezone:          { marker: '21600\0\0',     maxLen: 8, isNumeric: true, defaultValue: '21600' },
  max_frequency:     { marker: '80\0',          maxLen: 4, isNumeric: true, defaultValue: '80' },
  aspiration_time:   { marker: '10\0',          maxLen: 4, isNumeric: true, defaultValue: '10' },
};

function readU32LE(u8, off) {
  return (u8[off] | (u8[off+1]<<8) | (u8[off+2]<<16) | (u8[off+3]<<24)) >>> 0;
}

/**
 * ESP32 app images embed a checksum (XOR of all segment data bytes, seeded
 * with 0xEF) and, if the header's hash_appended flag is set, a trailing
 * SHA-256 over the whole image. The ROM bootloader verifies both on every
 * boot — any byte patch invalidates them, so they must be recomputed or the
 * chip will reboot-loop with "esp_image: Checksum failed".
 *
 * Image layout (esp-idf esp_app_format.h):
 *   offset 0:  magic byte, must be 0xE9
 *   offset 1:  segment_count
 *   offset 23: hash_appended (1 if a trailing SHA-256 is present)
 *   offset 24: first segment header (4 bytes load_addr + 4 bytes length),
 *              followed by `length` bytes of data, repeated segment_count times
 *   then:      zero-padding until (offset % 16 === 15), then 1 checksum byte
 *   then:      (if hash_appended) 32-byte SHA-256 over everything up to and
 *              including the checksum byte
 */
async function recalcEsp32ImageChecksum(u8) {
  if (u8[0] !== 0xE9) {
    throw new Error('Patched buffer does not look like a valid ESP32 app image (bad magic byte at offset 0).');
  }
  const segmentCount = u8[1];
  const hashAppended = u8[23] === 1;

  let offset = 24; // header size
  let checksum = 0xEF;

  for (let i = 0; i < segmentCount; i++) {
    const segLen = readU32LE(u8, offset + 4);
    offset += 8; // skip segment header (load_addr + length)
    for (let j = 0; j < segLen; j++) {
      checksum ^= u8[offset + j];
    }
    offset += segLen;
  }

  let checksumOffset = offset;
  while (checksumOffset % 16 !== 15) checksumOffset++;
  u8[checksumOffset] = checksum;

  if (hashAppended) {
    const hashOffset = checksumOffset + 1;
    const dataToHash = u8.slice(0, hashOffset);
    if (!crypto?.subtle) {
      throw new Error(
        'Web Crypto (crypto.subtle) is unavailable — this page must be served ' +
        'over HTTPS or localhost for SHA-256 recalculation to work.'
      );
    }
    const digest = await crypto.subtle.digest('SHA-256', dataToHash);
    u8.set(new Uint8Array(digest), hashOffset);
  }

  return u8;
}

function findMarker(u8, markerStr) {
  const enc = new TextEncoder();
  const needle = enc.encode(markerStr);

  outer:
  for (let i = 0; i <= u8.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (u8[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

function patchField(u8, field, value, marker, maxLen) {
  const enc = new TextEncoder();
  const valueBytes = enc.encode(value);

  if (valueBytes.length >= maxLen) {
    throw new Error(`"${field}" value "${value}" is ${valueBytes.length} chars — max is ${maxLen - 1}.`);
  }

  const offset = findMarker(u8, marker);
  if (offset === -1) {
    throw new Error(
      `Could not find placeholder for "${field}" in firmware.\n` +
      `Make sure you exported the .bin from the sketch with the matching placeholder buffers.`
    );
  }

  // write value + null terminator only — don't zero the rest of maxLen,
  // since adjacent bytes may belong to a different variable placed by the compiler
  const writeLen = valueBytes.length + 1;
  for (let i = 0; i < writeLen; i++) {
    u8[offset + i] = i < valueBytes.length ? valueBytes[i] : 0;
  }
}

/**
 * Patch a template .bin (ArrayBuffer) with the given config object.
 * configObj keys should match PLACEHOLDERS keys (id, wifi_ssid, wifi_pwd,
 * mq_ip, mq_port, topic, gpio_config, use_wifi, publish_interval,
 * reset_interval, timezone, max_frequency, aspiration_time).
 */
export async function patchEsp32Bin(fwBuf, configObj) {
  const u8 = new Uint8Array(fwBuf.slice(0));

  // find all markers first, so we fail fast before writing anything
  const locations = {};
  for (const [field, { marker, maxLen }] of Object.entries(PLACEHOLDERS)) {
    const offset = findMarker(u8, marker);
    if (offset === -1) {
      throw new Error(
        `Could not find placeholder for "${field}" in firmware.\n` +
        `Make sure the .bin was exported from the matching sketch version.`
      );
    }
    locations[field] = { offset, maxLen };
  }

  for (const [field, { maxLen }] of Object.entries(locations)) {
    const { marker, defaultValue } = PLACEHOLDERS[field];
    const value = String(configObj[field] ?? defaultValue ?? '');
    patchField(u8, field, value, marker, maxLen);
  }

  // MUST run after all byte patches — recomputes the checksum (and SHA-256,
  // if present) that the ROM bootloader verifies on every boot
  await recalcEsp32ImageChecksum(u8);

  return u8.buffer;
}

export async function buildPatchedEsp32Bin(
  configObj,
  firmwareUrl = 'firmware/mesonet_esp32.bin'
) {
  const bust = '?v=' + Date.now();
  const resp = await fetch(firmwareUrl + bust);
  if (!resp.ok) throw new Error(`Firmware not found (${resp.status}): ${firmwareUrl}`);
  const fwBuf = await resp.arrayBuffer();
  return patchEsp32Bin(fwBuf, configObj);
}