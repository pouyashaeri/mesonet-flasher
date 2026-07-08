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
export function patchEsp32Bin(fwBuf, configObj) {
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