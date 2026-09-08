// RP2040 browser flashing and LittleFS provisioning helpers.
//
// The RP2040 BOOTSEL bootloader appears as a USB mass-storage drive. Browsers
// cannot claim that protected USB interface directly, so the user grants access
// to the RPI-RP2 drive and this module writes the unchanged UF2 to it. After the
// firmware boots, configuration is sent to the running device over Web Serial.

const UF2_MAGIC_START0 = 0x0A324655;
const UF2_MAGIC_START1 = 0x9E5D5157;
const UF2_MAGIC_END = 0x0AB16F30;
const CONFIG_COMMAND = 'IOTWX_CONFIG ';
const CONFIG_LINE_MAX_BYTES = 2048;

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function validateUf2(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0 || bytes.byteLength % 512 !== 0) {
    throw new Error('The hosted RP2040 firmware is not a valid UF2 file.');
  }

  for (let offset = 0; offset < bytes.byteLength; offset += 512) {
    if (
      readUint32LE(bytes, offset) !== UF2_MAGIC_START0 ||
      readUint32LE(bytes, offset + 4) !== UF2_MAGIC_START1 ||
      readUint32LE(bytes, offset + 508) !== UF2_MAGIC_END
    ) {
      throw new Error(`Invalid UF2 block at byte ${offset}.`);
    }
  }
}

export function getRp2040BrowserError() {
  if (!window.isSecureContext) {
    return 'This page must be opened over HTTPS or localhost.';
  }
  if (!('showDirectoryPicker' in window)) {
    return 'Direct RP2040 flashing requires desktop Chrome or Microsoft Edge.';
  }
  if (!('serial' in navigator)) {
    return 'RP2040 configuration requires Web Serial in desktop Chrome or Microsoft Edge.';
  }
  if (window.top !== window.self) {
    return 'Direct drive access is blocked inside an embedded page. Open this flasher in its own tab.';
  }
  return null;
}

export async function fetchRp2040Firmware(
  firmwareUrl = 'firmware/mesonet_rp2040.uf2'
) {
  const separator = firmwareUrl.includes('?') ? '&' : '?';
  const response = await fetch(`${firmwareUrl}${separator}v=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`RP2040 firmware could not be loaded (${response.status}).`);
  }

  const firmware = await response.arrayBuffer();
  validateUf2(firmware);
  return firmware;
}

async function verifyRp2040Drive(directoryHandle) {
  const driveName = directoryHandle.name.toUpperCase();
  if (!driveName.includes('RPI') && !driveName.includes('RP2')) {
    throw new Error(`Select the RPI-RP2 drive, not "${directoryHandle.name}".`);
  }

  // The ROM BOOTSEL volume contains INFO_UF2.TXT. Requiring it prevents an
  // accidental write to an unrelated folder whose name merely looks similar.
  try {
    const infoHandle = await directoryHandle.getFileHandle('INFO_UF2.TXT');
    const infoFile = await infoHandle.getFile();
    const info = await infoFile.text();
    if (!/UF2|RP2040|RPI-RP2/i.test(info)) {
      throw new Error('The selected drive is not an RP2040 BOOTSEL volume.');
    }
  } catch (error) {
    if (error.message === 'The selected drive is not an RP2040 BOOTSEL volume.') {
      throw error;
    }
    throw new Error('The selected folder does not contain RP2040 BOOTSEL files.');
  }
}

export async function flashRP2040viaFilesystem(uf2ArrayBuffer, onProgress) {
  validateUf2(uf2ArrayBuffer);

  let directoryHandle;
  try {
    directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Drive selection was cancelled.');
    }
    throw error;
  }

  await verifyRp2040Drive(directoryHandle);
  onProgress?.(0, 1);

  const firmwareHandle = await directoryHandle.getFileHandle('firmware.uf2', {
    create: true,
  });
  const writable = await firmwareHandle.createWritable();

  try {
    await writable.write(uf2ArrayBuffer);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch (_) {
      // The board may already have rebooted and removed the drive.
    }
    throw error;
  }

  onProgress?.(1, 1);
}

function readWithTimeout(reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for a response from the RP2040.')),
      timeoutMs
    );

    reader.read().then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function provisioningErrorMessage(responseLine) {
  const reason = responseLine.replace('IOTWX_CONFIG_ERROR', '').trim();
  const messages = {
    MESSAGE_TOO_LONG: 'The configuration exceeds the firmware size limit.',
    INVALID_JSON: 'The device could not parse the configuration JSON.',
    INVALID_VALUES: 'The device rejected one or more configuration values.',
    WRITE_FAILED: 'The device could not write config.json to LittleFS.',
  };
  return messages[reason] || `The device rejected the configuration: ${reason}`;
}

export async function provisionRP2040(
  config,
  { baudRate = 115200, timeoutMs = 20000, onLine } = {}
) {
  const command = `${CONFIG_COMMAND}${JSON.stringify(config)}`;
  const commandBytes = new TextEncoder().encode(command);
  if (commandBytes.byteLength > CONFIG_LINE_MAX_BYTES) {
    throw new Error(
      `Configuration command is ${commandBytes.byteLength} bytes; maximum is ${CONFIG_LINE_MAX_BYTES}.`
    );
  }

  let port;
  let reader;
  let writer;

  try {
    try {
      port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x239A }],
      });
    } catch (error) {
      if (error.name === 'NotFoundError') {
        throw new Error('Serial device selection was cancelled.');
      }
      throw error;
    }

    await port.open({ baudRate });
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    } catch (_) {
      // Not every Web Serial implementation exposes signal control.
    }

    // Give Windows and the freshly booted USB CDC interface time to settle.
    await new Promise(resolve => setTimeout(resolve, 1000));

    writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode(`${command}\n`));
    writer.releaseLock();
    writer = null;
    onLine?.('[sent configuration to device]');

    reader = port.readable.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let pending = '';

    while (Date.now() < deadline) {
      const { value, done } = await readWithTimeout(
        reader,
        Math.max(1, deadline - Date.now())
      );
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        onLine?.(line);

        if (line === 'IOTWX_CONFIG_OK') {
          return typeof port.getInfo === 'function' ? port.getInfo() : {};
        }
        if (line.startsWith('IOTWX_CONFIG_ERROR')) {
          throw new Error(provisioningErrorMessage(line));
        }
      }
    }

    throw new Error('The RP2040 disconnected before confirming configuration.');
  } catch (error) {
    if ((error.message || '').includes('already open')) {
      throw new Error('The serial port is busy. Close Arduino Serial Monitor and try again.');
    }
    throw error;
  } finally {
    if (writer) {
      try {
        writer.releaseLock();
      } catch (_) {}
    }
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {}
      try {
        reader.releaseLock();
      } catch (_) {}
    }
    if (port) {
      try {
        await port.close();
      } catch (_) {
        // Expected when the RP2040 reboots after saving config.json.
      }
    }
  }
}

function matchesUsbDevice(port, expectedInfo) {
  if (typeof port.getInfo !== 'function') return true;
  const info = port.getInfo();
  if (info.usbVendorId !== 0x239A) return false;
  if (
    expectedInfo?.usbProductId !== undefined &&
    info.usbProductId !== expectedInfo.usbProductId
  ) {
    return false;
  }
  return true;
}

async function waitForAuthorizedRp2040(expectedInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ports = await navigator.serial.getPorts();
    for (const port of ports) {
      if (!matchesUsbDevice(port, expectedInfo)) continue;
      try {
        await port.open({ baudRate: 115200 });
        return port;
      } catch (_) {
        // Windows may expose the handle briefly before the reboot is complete.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error('The RP2040 did not reappear after reboot.');
}

export async function verifyRP2040Config(
  expectedInfo,
  { timeoutMs = 15000, onLine } = {}
) {
  let port;
  let reader;

  try {
    port = await waitForAuthorizedRp2040(expectedInfo, timeoutMs);
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    } catch (_) {}

    reader = port.readable.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let pending = '';

    while (Date.now() < deadline) {
      const { value, done } = await readWithTimeout(
        reader,
        Math.max(1, deadline - Date.now())
      );
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        onLine?.(line);

        if (line.includes('[info]: Loaded /config.json')) {
          return;
        }
        if (
          line === 'IOTWX_PROVISION_READY' ||
          line.includes('Using hardcoded defaults') ||
          line.includes('Configuration validation failed')
        ) {
          throw new Error('The RP2040 rebooted without loading the saved configuration.');
        }
      }
    }

    throw new Error('The RP2040 did not confirm loading /config.json after reboot.');
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {}
      try {
        reader.releaseLock();
      } catch (_) {}
    }
    if (port) {
      try {
        await port.close();
      } catch (_) {}
    }
  }
}
