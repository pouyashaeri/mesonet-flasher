/**
 * patch-uf2.js — flash address map search, corrected markers
 */

const PLACEHOLDERS = {
  firstname:    { marker: 'IOTWXFNAME0000000000000000000000',                maxLen: 48 },
  lastname:     { marker: 'IOTWXLNAME1234567890abcdefghijkl',                maxLen: 48 },
  email:        { marker: 'IOTWXEMAIL234567890abcdefghijklmnopqrstuvwxyzAB', maxLen: 64 },
  organization: { marker: 'IOTWXORGS34567890abcdefghijklmnopqrstuvwxyzABCDE', maxLen: 64 },
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
        readU32LE(u8, b+508) !== UF2_MAGIC2)
      throw new Error(`${label}: bad UF2 magic at block ${i}`);
  }
  return blocks;
}

function buildAddressMap(u8) {
  const blocks = u8.length / 512;
  const map = new Map();
  for (let i = 0; i < blocks; i++) {
    const base       = i * 512;
    const targetAddr = readU32LE(u8, base + 12);
    for (let j = 0; j < 256; j++)
      map.set(targetAddr + j, base + 32 + j);
  }
  return map;
}

function findMarkerInFlash(u8, addrMap, markerStr) {
  const enc    = new TextEncoder();
  const needle = enc.encode(markerStr);
  const blocks = u8.length / 512;

  for (let i = 0; i < blocks; i++) {
    const base       = i * 512;
    const targetAddr = readU32LE(u8, base + 12);
    for (let j = 0; j < 256; j++) {
      const startFlashAddr = targetAddr + j;
      let match = true;
      for (let k = 0; k < needle.length; k++) {
        const fileOff = addrMap.get(startFlashAddr + k);
        if (fileOff === undefined || u8[fileOff] !== needle[k]) { match = false; break; }
      }
      if (match) return startFlashAddr;
    }
  }
  return -1;
}

function patchByFlashAddress(u8, addrMap, field, value, marker, maxLen) {
  const enc        = new TextEncoder();
  const valueBytes = enc.encode(value);

  if (valueBytes.length >= maxLen)
    throw new Error(`${field} "${value}" is ${valueBytes.length} chars — max is ${maxLen - 1}.`);

  const startFlashAddr = findMarkerInFlash(u8, addrMap, marker);
  if (startFlashAddr === -1)
    throw new Error(
      `Could not find placeholder for "${field}" in firmware.\n` +
      `Make sure you compiled the latest .ino with char array fields.`
    );

  const replacement = new Uint8Array(maxLen);
  replacement.set(valueBytes);

  for (let i = 0; i < maxLen; i++) {
    const fileOff = addrMap.get(startFlashAddr + i);
    if (fileOff === undefined)
      throw new Error(`Flash address 0x${(startFlashAddr+i).toString(16)} not mapped for "${field}"`);
    u8[fileOff] = replacement[i];
  }
}

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

export async function buildCombinedUF2(
  configObj,
  firmwareUrl = 'firmware/mesonet_rp2040.uf2',
  templateUrl = 'firmware/config_template.uf2'
) {
  const bust = '?v=' + Date.now();
  const [fwResp, cfgResp] = await Promise.all([
      fetch(firmwareUrl + bust),
      fetch(templateUrl + bust),
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
