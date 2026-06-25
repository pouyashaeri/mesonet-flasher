// RP2040 WebUSB UF2 Flasher
// Targets VID 0x2E8A (Raspberry Pi), PID 0x0003 (BOOTSEL mode)

const RP2040_VENDOR_ID  = 0x2E8A;
const RP2040_PRODUCT_ID = 0x0003;
const UF2_BLOCK_SIZE    = 512;

let rp2040Device = null;

export async function connectRP2040() {
  rp2040Device = await navigator.usb.requestDevice({
    filters: [{ vendorId: RP2040_VENDOR_ID, productId: RP2040_PRODUCT_ID }]
  });
  await rp2040Device.open();
  if (rp2040Device.configuration === null)
    await rp2040Device.selectConfiguration(1);
  await rp2040Device.claimInterface(0);
  return rp2040Device;
}

export async function flashRP2040(uf2ArrayBuffer, onProgress) {
  if (!rp2040Device) throw new Error("No RP2040 connected");

  const data     = new Uint8Array(uf2ArrayBuffer);
  const numBlocks = Math.floor(data.length / UF2_BLOCK_SIZE);

  for (let i = 0; i < numBlocks; i++) {
    const block = data.slice(i * UF2_BLOCK_SIZE, (i + 1) * UF2_BLOCK_SIZE);
    // Write to EP1 OUT (RP2040 BOOTSEL MSC bulk endpoint)
    await rp2040Device.transferOut(1, block);
    if (onProgress) onProgress(i + 1, numBlocks);
  }

  // Device will reboot automatically after last block
  try { await rp2040Device.close(); } catch (_) {}
  rp2040Device = null;
}

export function isWebUSBSupported() {
  return navigator.usb !== undefined;
}