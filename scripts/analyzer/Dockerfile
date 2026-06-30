# Dockerfile — Render Docker Cron for the MAD BPM/Key analyzer (Essentia).
#
# Why Docker (not Render's native Python runtime): Essentia decodes the MP3s via
# ffmpeg/libav, and Render's native build can't apt-install system libs. This
# image bundles them so MP3 analysis works reliably.
#
# Build context = scripts/analyzer/ (so requirements.txt + mad_analyzer.py copy in).
FROM python:3.11-slim

# ffmpeg/libav = Essentia's audio decoding; libsndfile for WAV/FLAC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY mad_analyzer.py .

ENV PYTHONUNBUFFERED=1
# Finds FM records with empty AI_BPM, analyses, writes AI_* back. Creds via env.
ENTRYPOINT ["python", "mad_analyzer.py"]
CMD ["--limit", "300"]
