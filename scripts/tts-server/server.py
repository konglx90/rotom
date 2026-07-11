#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rotom TTS 服务(Qwen3-TTS)—— 部署在另一台 Mac 上,主力机经内网调用。
主力机零负担:推理的 CPU/GPU/内存/发热全部留在这台机器。

接口:
  GET  /health                                           健康检查
  GET  /speakers                                         内置音色列表
  POST /tts  {text, speaker?, language?, instruct?, token?}  → audio/wav

环境变量(可选):
  QWEN_TTS_MODEL    模型,默认 Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
  QWEN_TTS_DEVICE   设备,默认自动(mps > cuda > cpu)
  QWEN_TTS_DTYPE    精度,默认 bfloat16(M1 不稳就改 float16)
  QWEN_TTS_SPEAKER  默认音色,默认 Vivian(明亮中文女声)
  QWEN_TTS_LANG     默认语言,默认 Chinese
  QWEN_TTS_TOKEN    鉴权 token,设了之后请求必须带相同 token
  PORT              端口,默认 9321
"""
import os
import io
import time

import torch
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

MODEL = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
TOKEN = os.environ.get("QWEN_TTS_TOKEN", "")
DEFAULT_SPEAKER = os.environ.get("QWEN_TTS_SPEAKER", "Vivian")
DEFAULT_LANG = os.environ.get("QWEN_TTS_LANG", "Chinese")


def pick_device() -> str:
    d = os.environ.get("QWEN_TTS_DEVICE")
    if d:
        return d
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda:0"
    return "cpu"


def pick_dtype():
    name = os.environ.get("QWEN_TTS_DTYPE", "").lower()
    if name in ("float16", "fp16"):
        return torch.float16
    if name in ("bfloat16", "bf16"):
        return torch.bfloat16
    # 默认 bfloat16(M2+ MPS 支持)。M1 若报 dtype/算子错误,设 QWEN_TTS_DTYPE=float16。
    return torch.bfloat16


DEVICE = pick_device()
DTYPE = pick_dtype()

print(f"[rotom-tts] model={MODEL}")
print(f"[rotom-tts] device={DEVICE} dtype={DTYPE}")
print("[rotom-tts] loading model(首次自动下载权重,0.6B 约 1.8GB)…")

from qwen_tts import Qwen3TTSModel  # 放到打印之后,避免 import 耗时盖住上面的设备信息

# Mac MPS 不支持 flash_attention_2 → 用默认 attention(sdpa)。仅 CUDA 才加 flash。
load_kwargs: dict = {"device_map": DEVICE, "dtype": DTYPE}
if DEVICE.startswith("cuda"):
    load_kwargs["attn_implementation"] = "flash_attention_2"

model = Qwen3TTSModel.from_pretrained(MODEL, **load_kwargs)

# 预热:首条推理含图构建/编译,提前跑一遍,避免第一条消息特别慢。
try:
    model.generate_custom_voice(text="语音服务已就绪。", language=DEFAULT_LANG, speaker=DEFAULT_SPEAKER)
    print("[rotom-tts] warmup ok")
except Exception as e:  # noqa: BLE001
    print(f"[rotom-tts] warmup 失败(可忽略,正式请求仍会工作):{e}")

print("[rotom-tts] ready 🎤")

app = FastAPI(title="rotom TTS (Qwen3-TTS)")
# 允许主力机浏览器跨域调用。要更严可把 "*" 改成 "http://<主力机IP>:28800"。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TTSReq(BaseModel):
    text: str
    speaker: str | None = None
    language: str | None = None
    instruct: str | None = Field(default=None, description="可选:语气指令,如「用平静的语气说」")
    token: str | None = None


def auth(token: str | None):
    if TOKEN and token != TOKEN:
        raise HTTPException(status_code=401, detail="invalid token")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "device": DEVICE, "dtype": str(DTYPE)}


@app.get("/speakers")
def speakers():
    try:
        return JSONResponse(model.get_supported_speakers())
    except Exception:  # noqa: BLE001
        return ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]


@app.post("/tts")
def tts(req: TTSReq):
    auth(req.token)
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    speaker = req.speaker or DEFAULT_SPEAKER
    language = req.language or DEFAULT_LANG
    t0 = time.time()
    kwargs = {"text": text, "language": language, "speaker": speaker}
    if req.instruct:
        kwargs["instruct"] = req.instruct
    wavs, sr = model.generate_custom_voice(**kwargs)
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    print(f"[tts] {len(text)}字 speaker={speaker} {time.time() - t0:.2f}s")
    return StreamingResponse(buf, media_type="audio/wav", headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "9321"))
    uvicorn.run(app, host="0.0.0.0", port=port)
