# rotom 语音播报 —— TTS 服务部署方案(另一台 Mac)

> 目标:把 Qwen3-TTS 跑在**另一台 Mac** 上当语音服务器,主力机(编程机)只在收到群消息时
> 发一个 HTTP 请求过来拿音频播放。**推理的 CPU/GPU/内存/发热全部留在这台机器,主力机零负担。**

```
主力机(编程/公司项目,要安静)         另一台 Mac(本方案,常驻 TTS 服务)
  rotom dashboard 播报 ──内网 HTTP──▶  server.py(:9321)
   fetch /tts → <audio>.play()            └─ Qwen3-TTS 本地推理(MPS)
```

主力机那边只是「发文本 → 播音频」,内存几 MB、不吃 GPU。所有重的都在这台 Mac。

---

## 一、这台 Mac 的硬件要求

| 项目 | 要求 |
|---|---|
| 芯片 | Apple Silicon(M1 起即可;M2+ 更稳,支持 bfloat16) |
| 内存 | **≥ 8GB**(0.6B 占 ~4GB);16GB+ 更从容,可同时干别的 |
| 磁盘 | 模型 ~2GB + conda 环境 ~3GB |
| 网络 | 与主力机在同一内网(同 WiFi / 办公网 / VPN 可达) |
| 状态 | **能常开**(当服务器,不要每天关 / 睡眠时服务会断) |

> 如果这台 Mac 内存很小、或不想它发热,就走 **Edge TTS 代理**方案(见文末附录),
> 那台机器也几乎零负担。本主方案默认 Qwen3-TTS(音色最好)。

---

## 二、选型说明(已替你定好默认)

- **模型:`Qwen3-TTS-12Hz-0.6B-CustomVoice`**(1.8GB、~4GB 内存、Mac 友好)。
  CustomVoice 版**自带 9 个内置音色**,无需克隆,开箱即用。
- **音色:默认 `Vivian`**(明亮中文女声)。可选 `Serena`(温柔中文女)、`Uncle_Fu`/`Dylan`/`Eric`(中文男)等。
- 想要更高音色可换 `1.7B-CustomVoice`(`QWEN_TTS_MODEL` 改一下即可,内存 ~6GB)。

完整音色表:`GET /speakers`,或官方 [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)。

---

## 三、部署步骤

### 1. 装 conda + 建独立环境(Python 3.12)

```bash
# 没有 conda 先装 Miniconda:https://docs.conda.io/en/latest/miniconda.html
conda create -n qwen3-tts python=3.12 -y
conda activate qwen3-tts
```

### 2. 装 qwen-tts + 服务依赖

```bash
pip install -U qwen-tts soundfile fastapi "uvicorn[standard]"
# 国内加速模型下载(可选,推荐):
pip install -U modelscope
```

### 3. 预下载模型(避免首次启动卡在下载)

```bash
# 国内用 ModelScope 快;海外可跳过,from_pretrained 会自动从 HuggingFace 下
modelscope download --model Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice --local_dir ~/models/Qwen3-TTS-12Hz-0.6B-CustomVoice
```

> 下完可用本地目录当模型:`export QWEN_TTS_MODEL=~/models/Qwen3-TTS-12Hz-0.6B-CustomVoice`
> (否则默认走在线 id,首次仍会下;下过一次会进缓存。)

### 4. 放服务脚本并启动

把本目录的 `server.py` 拷到一个固定位置,例如 `~/scripts/tts-server/server.py`:

```bash
mkdir -p ~/scripts/tts-server
cp server.py ~/scripts/tts-server/server.py
cd ~/scripts/tts-server

# 先手动跑一次,看模型能否正常加载 + 预热
python server.py
```

看到 `[rotom-tts] ready 🎤` 就成了。**保持这个终端先开着**做验证,后面再换成开机自启。

### 5. 在本机自测

```bash
# 健康检查
curl http://localhost:9321/health

# 合成一句到文件,用 QuickTime/afplay 听
curl -X POST http://localhost:9321/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"你好,这是 rotom 语音播报的测试。"}' \
  --output test.wav
afplay test.wav
```

能听到 Vivian 念出来,服务就 OK。

---

## 四、开机自启(launchd)

把 `com.rotom.tts-server.plist` 复制到 `~/Library/LaunchAgents/`,按里面注释改 3 处 `<YOU>` 占位
(python 路径、server.py 路径、token),然后:

```bash
launchctl load ~/Library/LaunchAgents/com.rotom.tts-server.plist

# 查看运行日志
tail -f /tmp/rotom-tts.log /tmp/rotom-tts.err.log

# 停止 / 卸载
launchctl unload ~/Library/LaunchAgents/com.rotom.tts-server.plist
```

`KeepAlive=true`,崩了会自动拉起;`RunAtLoad=true`,开机/登录自动启动。

> 注意:macOS 合盖/睡眠时服务会挂起。要在「系统设置 → 电池 / 节能」里把
> **「防止自动进入睡眠」**打开(台式机无此问题),或外接电源时保持唤醒。

---

## 五、让主力机访问(内网开放)

### 1. 查这台 Mac 的内网 IP

```bash
ipconfig getifaddr en0   # WiFi 通常是 en0;有线可能是 en1
```

假设拿到 `192.168.1.23`。

### 2. 放行端口

macOS 默认防火墙一般不拦监听端口;若装了防火墙/安全软件,放行 **9321**。
确认两台机器能互通:`ping 192.168.1.23`(从主力机执行)。

### 3. 从主力机验证

```bash
curl http://192.168.1.23:9321/health
```

通了就能用。若设了 token,带上:

```bash
curl -X POST http://192.168.1.23:9321/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"跨机测试","token":"你在 plist 里设的 token"}' --output t.wav
```

---

## 六、主力机 dashboard 配置(待我改完 dashboard)

服务就绪后,在 rotom dashboard 的「语音播报设置」里填:

- **后端**:Qwen3-TTS
- **服务端点**:`http://192.168.1.23:9321`
- **Token**:和 plist 里一致(没设就留空)
- **音色 / 语速**:可选

> dashboard 这端的「可切换后端 + 设置面板」由我随后实现(替换当前的浏览器系统语音)。
> 服务端先跑通,联调时直接填上面的端点即可。

---

## 七、资源占用 & 排障

| 现象 | 处理 |
|---|---|
| M1 报 dtype / 算子错误 | `export QWEN_TTS_DTYPE=float16` 再启动 |
| MPS 仍报错 | `export QWEN_TTS_DEVICE=cpu`(慢但能跑) |
| 首条消息很慢 | 正常,预热已尽量缓解;模型越大越明显 |
| 内网连不通 | 检查同网段、防火墙、Mac 是否睡眠 |
| 想换音色 | `export QWEN_TTS_SPEAKER=Serena` 或请求里传 `speaker` |
| 跨域被浏览器拦 | server 已开 `CORS *`;若仍拦,确认请求的是 `http://<IP>:9321` |

**资源参考**(0.6B):常驻内存 ~4GB;念一句(20 字)M 芯片约 0.5~1.5s,GPU/CPU 期间拉满、有发热,不念时空闲。

---

## 附录:更省的 Edge TTS 代理(不想跑大模型时)

如果这台 Mac 也想零负担,改用 Edge TTS(免费、无需 token、音色接近豆包),服务脚本换成:

```bash
conda activate qwen3-tts   # 复用环境,或新建一个
pip install edge-tts fastapi "uvicorn[standard]"
```

`edge_proxy.py` 核心逻辑(POST /tts → 调 edge-tts → 返回 mp3):

```python
import io, edge_tts, asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class Req(BaseModel):
    text: str
    voice: str = "zh-CN-XiaoxiaoNeural"   # 中文女;男声 zh-CN-YunxiNeural
    rate: str = "+0%"                      # 语速,如 -10%

@app.post("/tts")
async def tts(req: Req):
    buf = io.BytesIO()
    async for chunk in edge_tts.Communicate(req.text, req.voice, rate=req.rate).stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    buf.seek(0)
    return StreamingResponse(buf, media_type="audio/mpeg")
```

启动 `uvicorn edge_proxy:app --host 0.0.0.0 --port 9321`,其余步骤(自测、launchd、内网开放、dashboard 配置)完全相同。音色中 `zh-CN-XiaoxiaoNeural`(晓晓)最接近豆包风格。

---

**参考**:[Qwen3-TTS 官方仓库](https://github.com/QwenLM/Qwen3-TTS) · [edge-tts](https://github.com/rany2/edge-tts)
