#!/usr/bin/env python3
"""
Digital Cupboard — Demucs AI Stem Server  (v3 — Python API)
─────────────────────────────────────────
Run:  python3 demucs-server.py
Then click AI Split in the audio app.
"""

import os, sys, json, base64, tempfile, traceback, subprocess
from pathlib import Path

PORT = 8765

# ── Virtual-environment bootstrap ─────────────────────────────────────────────
# Creates a venv next to this script on first run, installs dependencies into
# it, then re-launches the script inside the venv so everything just works —
# no system-pip restrictions, no Python version conflicts.

SCRIPT_DIR = Path(__file__).parent.resolve()
VENV_DIR   = SCRIPT_DIR / ".demucs-env"
VENV_PYTHON = VENV_DIR / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")

def _in_venv():
    return sys.prefix != sys.base_prefix or str(VENV_DIR) in sys.prefix

if not _in_venv():
    # ── Create venv if missing ────────────────────────────────────────────────
    if not VENV_PYTHON.exists():
        print("🔧 Creating virtual environment (.demucs-env) — first run only…")
        # Prefer python3.11 or python3.12 for best Demucs/torch compatibility
        base_python = sys.executable
        for candidate in ["python3.12", "python3.11", "python3.10", "python3"]:
            try:
                out = subprocess.check_output([candidate, "--version"], stderr=subprocess.STDOUT, text=True)
                ver = out.strip().split()[-1]
                major, minor = int(ver.split(".")[0]), int(ver.split(".")[1])
                if major == 3 and minor <= 12:
                    base_python = candidate
                    print(f"   Using {candidate} ({ver}) for compatibility")
                    break
            except Exception:
                continue
        subprocess.check_call([base_python, "-m", "venv", str(VENV_DIR)])
        print("✓ Virtual environment created")

    # ── Install packages into venv ────────────────────────────────────────────
    pip = str(VENV_DIR / ("Scripts/pip.exe" if sys.platform == "win32" else "bin/pip"))
    pkgs = ["demucs", "soundfile", "scipy", "numpy"]
    for pkg in pkgs:
        try:
            subprocess.check_call([pip, "install", "--quiet", pkg])
            print(f"✓ {pkg} ready")
        except subprocess.CalledProcessError as e:
            print(f"✗ Failed to install {pkg}: {e}")

    # ── Re-launch inside venv ─────────────────────────────────────────────────
    print("\n🚀 Starting server inside virtual environment…\n")
    os.execv(str(VENV_PYTHON), [str(VENV_PYTHON)] + sys.argv)
    sys.exit(0)  # never reached

# ── Running inside the venv from here on ─────────────────────────────────────
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import demucs
print(f"✓ Demucs {demucs.__version__}")

# ── Pre-load torch so the first request isn't slow ───────────────────────────
print("Loading torch…")
import torch
print(f"✓ torch {torch.__version__}")

# Fix SSL cert verification failure common with python.org Python on macOS.
# Only affects model downloads from dl.fbaipublicfiles.com — safe to bypass.
import ssl
ssl._create_default_https_context = ssl._create_unverified_context

# ── Stem separation ───────────────────────────────────────────────────────────
def separate(audio_bytes: bytes) -> dict:
    import soundfile as sf
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    # ── Load model (downloads ~330 MB on first use, then cached) ─────────────
    # Find the default model name for this installed version of demucs
    try:
        from demucs.pretrained import DEFAULT_MODEL
        default = DEFAULT_MODEL
    except ImportError:
        default = None

    names_to_try = list(dict.fromkeys(filter(None, [default, "htdemucs", "mdx_extra", "demucs", "demucs48_hq"])))
    print(f"  Will try models: {names_to_try}")

    model = None
    errors = []
    for name in names_to_try:
        try:
            print(f"  Trying model: {name}…")
            model = get_model(name=name)
            print(f"  ✓ Model loaded: {name}")
            break
        except Exception as e:
            msg = f"{name}: {type(e).__name__}: {e}"
            errors.append(msg)
            print(f"  ✗ {msg}")

    if model is None:
        detail = "\n".join(errors)
        raise RuntimeError(
            f"No Demucs model could be loaded.\n\n{detail}\n\n"
            "Try:  pip3 install --upgrade demucs\n"
            "Or check your internet connection (models download on first use)."
        )

    model.eval()
    print(f"  Sources: {model.sources}")

    # ── Load audio from bytes via a temp file ─────────────────────────────────
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(audio_bytes)
        tmp_in = f.name

    try:
        data, sr = sf.read(tmp_in, always_2d=True)   # shape: (samples, channels)
        wav = torch.tensor(data.T, dtype=torch.float32)  # → (channels, samples)
    finally:
        os.unlink(tmp_in)

    # ── Ensure stereo ─────────────────────────────────────────────────────────
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    elif wav.shape[0] > 2:
        wav = wav[:2]

    # ── Resample to model rate ────────────────────────────────────────────────
    if sr != model.samplerate:
        print(f"  Resampling {sr} Hz → {model.samplerate} Hz…")
        # Use scipy for resampling — avoids torchaudio backend dependency
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(int(sr), int(model.samplerate))
        up, down = int(model.samplerate) // g, int(sr) // g
        resampled = resample_poly(wav.numpy(), up, down, axis=1)
        wav = torch.tensor(resampled, dtype=torch.float32)

    # ── Normalise ─────────────────────────────────────────────────────────────
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()

    # ── Separate ──────────────────────────────────────────────────────────────
    print("  Separating (this may take 1–3 minutes)…")
    with torch.no_grad():
        sources = apply_model(
            model,
            wav.unsqueeze(0),
            device="cpu",
            progress=True,
            num_workers=1,
        )[0]

    # ── Denormalise ───────────────────────────────────────────────────────────
    sources = sources * ref.std() + ref.mean()

    # ── Encode each stem as WAV → base64 ─────────────────────────────────────
    # Pure stdlib + PyTorch — no numpy or soundfile needed here.
    import io as _io, wave as _wave, struct as _struct

    def _tensor_to_wav(tensor, sr):
        """Convert (channels, samples) float32 tensor → WAV bytes. No numpy."""
        if tensor.dim() == 1:
            tensor = tensor.unsqueeze(0)
        channels, samples = tensor.shape
        t16 = (tensor.clamp(-1.0, 1.0) * 32767).to(torch.int16)
        # Interleave channels: (channels, samples) → (samples, channels) → flat
        interleaved = t16.T.contiguous().reshape(-1)
        try:
            pcm = interleaved.tobytes()          # PyTorch >= 1.10
        except AttributeError:
            pcm = _struct.pack(f'<{interleaved.numel()}h', *interleaved.tolist())
        buf = _io.BytesIO()
        with _wave.open(buf, 'wb') as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(2)   # 16-bit
            wf.setframerate(sr)
            wf.writeframes(pcm)
        buf.seek(0)
        return buf

    stems = {}
    for i, stem_name in enumerate(model.sources):
        wav_buf = _tensor_to_wav(sources[i].cpu(), model.samplerate)
        stems[stem_name] = base64.b64encode(wav_buf.read()).decode()
        print(f"  ✓ {stem_name}")

    return stems


# ── HTTP handler ──────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # quiet

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/ping":
            self._json(200, {"status": "ok", "model": "htdemucs"})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/split":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        audio  = self.rfile.read(length)
        print(f"\n→ Received {len(audio)/1_048_576:.1f} MB")

        try:
            stems = separate(audio)
            self._json(200, stems)
            print("  ✓ Stems sent to app\n")
        except Exception:
            tb = traceback.format_exc()
            print("  ✗ Full error:\n")
            print(tb)          # full traceback in terminal
            self._json(500, {"error": tb})


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print()
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        host_ip = s.getsockname()[0]
        s.close()
    except Exception:
        host_ip = "unknown"
    print("🎛️  Digital Cupboard — Demucs AI Stem Server")
    print(f"   Local:   http://localhost:{PORT}")
    print(f"   Network: http://{host_ip}:{PORT}")
    print("   Press Ctrl+C to stop")
    print()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n   Stopped.")
