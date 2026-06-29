#!/usr/bin/env python3
"""
Minimal FastAPI endpoint: POST /build-config-uf2
Accepts JSON body, returns config.uf2 binary.
Deploy on Oracle VPS alongside VisionMRT.

Install: pip install fastapi uvicorn littlefs-python
Run:     uvicorn build_config_uf2:app --host 0.0.0.0 --port 8765
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
import littlefs, json, struct

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten to your GitHub Pages URL in prod
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

BLOCK_SIZE  = 4096
BLOCK_COUNT = 256        # 1MB FS
FS_OFFSET   = 7 * 1024 * 1024
FLASH_BASE  = 0x10000000
UF2_PAYLOAD = 256
UF2_MAGIC0  = 0x0A324655
UF2_MAGIC1  = 0x9E5D5157
UF2_MAGIC2  = 0x0AB16F30
UF2_FAMILY  = 0xe48bff56

def build_uf2(json_text: str) -> bytes:
    fs = littlefs.LittleFS(
        block_size=BLOCK_SIZE,
        block_count=BLOCK_COUNT,
        prog_size=256,
        read_size=256,
        name_max=255,
    )
    with fs.open('/config.json', 'w') as f:
        f.write(json_text)
    image = bytes(fs.context.buffer)

    total = (len(image) + UF2_PAYLOAD - 1) // UF2_PAYLOAD
    uf2   = bytearray(total * 512)
    for i in range(total):
        base = i * 512
        addr = FLASH_BASE + FS_OFFSET + i * UF2_PAYLOAD
        struct.pack_into('<IIIIIIII', uf2, base,
            UF2_MAGIC0, UF2_MAGIC1, 0x00002000, addr,
            UF2_PAYLOAD, i, total, UF2_FAMILY)
        chunk = image[i*UF2_PAYLOAD:(i+1)*UF2_PAYLOAD]
        uf2[base+32:base+32+len(chunk)] = chunk
        struct.pack_into('<I', uf2, base+508, UF2_MAGIC2)
    return bytes(uf2)


@app.post("/build-config-uf2")
async def build_config_uf2(body: dict):
    try:
        json_text = json.dumps(body, indent=2)
        uf2_bytes = build_uf2(json_text)
        return Response(
            content=uf2_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": "attachment; filename=config.uf2"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health():
    return {"status": "ok"}
