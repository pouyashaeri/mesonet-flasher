// RP2040 Flash Helper
// The RP2040 BOOTSEL bootloader enumerates as USB Mass Storage —
// Chrome blocks claimInterface on protected classes, so direct
// WebUSB flashing is not possible. The correct method is the
// File System Access API: write the .uf2 directly to the RPI-RP2 drive.

export function isFileSystemAccessSupported() {
  return 'showDirectoryPicker' in window;
}

export async function flashRP2040viaFilesystem(uf2ArrayBuffer, onProgress) {
  // Ask user to select the RPI-RP2 drive
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('No drive selected — cancelled.');
    throw e;
  }

  // Sanity check: warn if it doesn't look like RPI-RP2
  const name = dirHandle.name.toUpperCase();
  if (!name.includes('RPI') && !name.includes('RP2')) {
    const ok = confirm(
      `Selected drive "${dirHandle.name}" doesn't look like RPI-RP2.\n` +
      `Continue anyway?`
    );
    if (!ok) throw new Error('Aborted — wrong drive selected.');
  }

  if (onProgress) onProgress(0, 1);

  const fileHandle = await dirHandle.getFileHandle('firmware.uf2', { create: true });
  const writable   = await fileHandle.createWritable();
  await writable.write(uf2ArrayBuffer);
  await writable.close();

  if (onProgress) onProgress(1, 1);
  // Board auto-reboots after the .uf2 lands on the drive
}
