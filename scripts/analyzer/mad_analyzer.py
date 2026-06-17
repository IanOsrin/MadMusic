#!/usr/bin/env python3
"""
MAD Music Analyzer (Render-ready)
=================================
Pulls tracks that still need analysis from FileMaker, downloads the audio from
S3, analyses it with Essentia, and writes the AI_* metadata back.

Differences from the original local tool, so it can run unattended on Render:
  • Secrets come from ENV (FM_USER/FM_PASS + the AWS default chain) — nothing
    secret is committed. Non-secret settings have built-in defaults, overridable
    by env. (A local config.json is still honoured if present, for convenience.)
  • Track selection is STATELESS: it asks FileMaker for records whose AI_BPM is
    empty (FM "=" matches empty) instead of relying on a local progress.json,
    which Render's ephemeral disk would not persist. This also auto-picks-up
    newly-added tracks.
  • The FM token is refreshed on 401 (the original run died when the token
    expired mid-backfill).
  • Tracks that can't be analysed (missing/corrupt audio) get a sentinel written
    (AI_BPM = -1 + a note) so they're excluded from the find and never loop.

Fields populated: AI_BPM, AI_Key, AI_Mood, AI_Energy, AI_QualityScore, AI_QualityNotes

Usage:
  python mad_analyzer.py --limit 300            # process up to 300 unanalysed tracks
  python mad_analyzer.py --limit 10 --dry-run   # analyse, but don't write to FM
"""

import os
import sys
import json
import time
import tempfile
import logging
import argparse
import requests
import boto3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

FAIL_SENTINEL = -1  # written to AI_BPM when a track can't be analysed, so the
                    # find-for-empty query stops returning it forever.


# ── Config: env first (Render), optional local config.json, built-in defaults ──
def load_config():
    file_cfg = {}
    path = os.environ.get("ANALYZER_CONFIG", "config.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                file_cfg = json.load(f)
        except Exception as e:
            log.warning(f"Could not read {path}: {e}")

    fm_file = file_cfg.get("filemaker", {})
    s3_file = file_cfg.get("s3", {})
    fields_file = fm_file.get("fields", {})

    def env(name, *fallbacks, default=None):
        for v in (os.environ.get(name), *fallbacks):
            if v not in (None, ""):
                return v
        return default

    cfg = {
        "filemaker": {
            "host": env("FM_HOST", fm_file.get("host"), default="https://digitalcupboard.fmcloud.fm"),
            "database": env("FM_DB", fm_file.get("database"), default="MadStreamer"),
            "layout": env("FM_LAYOUT", fm_file.get("layout"), default="Song Files"),
            "username": env("FM_USER", fm_file.get("username")),
            "password": env("FM_PASS", fm_file.get("password")),
            "verify_ssl": fm_file.get("verify_ssl", True),
            "filename_field": env("FM_FILENAME_FIELD", fm_file.get("filename_field"), default="Filename"),
            "fields": {
                "bpm": fields_file.get("bpm", "AI_BPM"),
                "key": fields_file.get("key", "AI_Key"),
                "mood": fields_file.get("mood", "AI_Mood"),
                "energy": fields_file.get("energy", "AI_Energy"),
                "quality_score": fields_file.get("quality_score", "AI_QualityScore"),
                "quality_notes": fields_file.get("quality_notes", "AI_QualityNotes"),
            },
        },
        "s3": {
            "bucket": env("S3_BUCKET", s3_file.get("bucket"), default="mass-music-audio-files"),
            "prefix": env("S3_PREFIX", s3_file.get("prefix"), default="mp3"),
            "region": env("AWS_REGION", s3_file.get("region"), default="eu-north-1"),
            # creds: env / instance role via the boto3 default chain (config keys
            # honoured only as a local fallback).
            "access_key": env("AWS_ACCESS_KEY_ID", s3_file.get("access_key")),
            "secret_key": env("AWS_SECRET_ACCESS_KEY", s3_file.get("secret_key")),
        },
    }
    if not cfg["filemaker"]["username"] or not cfg["filemaker"]["password"]:
        log.error("Missing FM credentials — set FM_USER and FM_PASS (env) or config.json.")
        sys.exit(1)
    return cfg


# ── FileMaker Data API (with token refresh) ─────────────────────────────────────
class FileMakerAPI:
    def __init__(self, cfg):
        f = cfg["filemaker"]
        self.host = f["host"].rstrip("/")
        self.database = f["database"]
        self.layout = f["layout"]
        self.username = f["username"]
        self.password = f["password"]
        self.verify = f.get("verify_ssl", True)
        self.token = None
        self.session = requests.Session()
        self.session.verify = self.verify
        self.base = f"{self.host}/fmi/data/v1/databases/{self.database}"

    def login(self):
        r = requests.post(
            f"{self.base}/sessions",
            auth=(self.username, self.password),
            headers={"Content-Type": "application/json"},
            json={}, verify=self.verify,
        )
        r.raise_for_status()
        self.token = r.json()["response"]["token"]
        self.session.headers.update({"Authorization": f"Bearer {self.token}"})
        log.info("FileMaker login OK")

    def logout(self):
        if self.token:
            try:
                self.session.delete(f"{self.base}/sessions/{self.token}")
            except Exception:
                pass
            self.token = None

    def _request(self, method, url, **kwargs):
        """Send a request; on 401 (expired token) re-login once and retry."""
        r = self.session.request(method, url, **kwargs)
        if r.status_code == 401:
            log.info("FM token expired — re-authenticating")
            self.login()
            r = self.session.request(method, url, **kwargs)
        r.raise_for_status()
        return r

    def find_unanalysed(self, bpm_field, limit):
        """Records whose AI_BPM is empty ('=' matches empty in FM)."""
        body = {"query": [{bpm_field: "="}], "limit": int(limit)}
        try:
            r = self._request("POST", f"{self.base}/layouts/{self.layout}/_find", json=body)
        except requests.HTTPError as e:
            # 401 with code 401 = no records found → treat as empty
            if e.response is not None and e.response.status_code == 404:
                return []
            data = e.response.json() if e.response is not None else {}
            if any(m.get("code") == "401" for m in data.get("messages", [])):
                return []
            raise
        data = r.json()["response"]
        return data.get("data", [])

    def update_record(self, record_id, fields):
        r = self._request(
            "PATCH",
            f"{self.base}/layouts/{self.layout}/records/{record_id}",
            json={"fieldData": fields},
        )
        return r.json()


# ── S3 Download ──────────────────────────────────────────────────────────────
class S3Downloader:
    def __init__(self, cfg):
        s3cfg = cfg["s3"]
        self.bucket = s3cfg["bucket"]
        self.prefix = (s3cfg.get("prefix") or "").rstrip("/")
        kwargs = {"region_name": s3cfg.get("region", "eu-north-1")}
        # Only pass explicit creds if present; otherwise use the default chain.
        if s3cfg.get("access_key") and s3cfg.get("secret_key"):
            kwargs["aws_access_key_id"] = s3cfg["access_key"]
            kwargs["aws_secret_access_key"] = s3cfg["secret_key"]
        self.client = boto3.client("s3", **kwargs)

    def download(self, filename, dest_path):
        key = f"{self.prefix}/{filename}" if self.prefix else filename
        self.client.download_file(self.bucket, key, dest_path)


# ── Essentia analysis (unchanged from the working local tool) ───────────────────
def pool_get(pool, key, default=None):
    try:
        if pool.containsKey(key):
            return pool[key]
        return default
    except Exception:
        return default


def analyze_audio(audio_path):
    try:
        import essentia
        import essentia.standard as es

        essentia.log.infoActive = False
        essentia.log.warningActive = False

        extractor = es.MusicExtractor(
            lowlevelStats=["mean", "stdev"],
            rhythmStats=["mean", "stdev"],
            tonalStats=["mean", "stdev"],
        )
        features, _ = extractor(audio_path)

        bpm = round(float(pool_get(features, "rhythm.bpm", 0)), 1)
        key = pool_get(features, "tonal.key_edma.key", "Unknown")
        scale = pool_get(features, "tonal.key_edma.scale", "")
        key_str = f"{key} {scale}".strip()
        loudness = float(pool_get(features, "lowlevel.average_loudness", 0.5))
        energy = round(min(max(loudness * 100, 0), 100), 1)
        danceability = float(pool_get(features, "rhythm.danceability", 0.5))
        spectral_complexity = float(pool_get(features, "lowlevel.spectral_complexity.mean", 5))
        mood = _classify_mood(energy, danceability, spectral_complexity)
        quality_score, quality_notes = _assess_quality(features)

        return {
            "bpm": bpm, "key": key_str, "mood": mood, "energy": energy,
            "quality_score": quality_score, "quality_notes": quality_notes,
        }
    except Exception as e:
        log.warning(f"  Essentia error: {e}")
        return None


def _classify_mood(energy, danceability, spectral_complexity):
    high_energy = energy > 60
    high_dance = danceability > 0.6
    high_complexity = spectral_complexity > 8
    if high_energy and high_dance:
        return "Happy / Energetic"
    elif high_energy and not high_dance:
        return "Aggressive / Intense"
    elif not high_energy and high_complexity:
        return "Sad / Melancholic"
    else:
        return "Relaxed / Calm"


def _assess_quality(features):
    issues = []
    score = 100
    loudness = float(pool_get(features, "lowlevel.average_loudness", 0.5))
    if loudness < 0.05:
        issues.append("possibly silent"); score -= 40
    dynamic_range = float(pool_get(features, "lowlevel.dynamic_complexity", 5))
    if dynamic_range < 2:
        issues.append("heavily compressed"); score -= 20
    elif dynamic_range > 15:
        issues.append("high dynamic range")
    duration = float(pool_get(features, "metadata.audio_properties.length", 60))
    if duration < 20:
        issues.append(f"short ({int(duration)}s)"); score -= 15
    return max(0, score), (", ".join(issues) if issues else "OK")


def build_fm_fields(analysis, cfg):
    fc = cfg["filemaker"]["fields"]
    fm = {}
    if analysis["bpm"] is not None:
        fm[fc["bpm"]] = analysis["bpm"]
    if analysis["key"]:
        fm[fc["key"]] = analysis["key"]
    if analysis["mood"]:
        fm[fc["mood"]] = analysis["mood"]
    if analysis["energy"] is not None:
        fm[fc["energy"]] = analysis["energy"]
    if analysis["quality_score"] is not None:
        fm[fc["quality_score"]] = analysis["quality_score"]
        fm[fc["quality_notes"]] = analysis["quality_notes"]
    return fm


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="MAD Music Analyzer (Render-ready)")
    ap.add_argument("--limit", type=int, default=300, help="Max tracks per run (default 300)")
    ap.add_argument("--dry-run", action="store_true", help="Analyse but don't write to FileMaker")
    args = ap.parse_args()

    cfg = load_config()

    try:
        import essentia  # noqa: F401
        log.info(f"Essentia {essentia.__version__}")
    except ImportError:
        log.error("Essentia not installed (pip install -r requirements.txt)")
        sys.exit(1)

    fm = FileMakerAPI(cfg)
    fm.login()
    s3 = S3Downloader(cfg)

    fields = cfg["filemaker"]["fields"]
    bpm_field = fields["bpm"]
    filename_field = cfg["filemaker"]["filename_field"]

    done = failed = 0
    try:
        records = fm.find_unanalysed(bpm_field, args.limit)
        log.info(f"{len(records)} tracks need analysis (limit {args.limit}){' [DRY RUN]' if args.dry_run else ''}")

        with tempfile.TemporaryDirectory() as tmp:
            for rec in records:
                rid = rec["recordId"]
                filename = (rec["fieldData"].get(filename_field) or "").strip()
                if not filename:
                    if not args.dry_run:
                        try: fm.update_record(rid, {bpm_field: FAIL_SENTINEL, fields["quality_notes"]: "no filename"})
                        except Exception: pass
                    failed += 1
                    continue

                name = filename + ".mp3"
                local = os.path.join(tmp, os.path.basename(name))
                try:
                    s3.download(name, local)
                except Exception as e:
                    log.warning(f"  S3 miss {name}: {e}")
                    if not args.dry_run:
                        try: fm.update_record(rid, {bpm_field: FAIL_SENTINEL, fields["quality_notes"]: "audio missing"})
                        except Exception: pass
                    failed += 1
                    continue

                analysis = analyze_audio(local)
                try: os.remove(local)
                except OSError: pass

                if not analysis:
                    if not args.dry_run:
                        try: fm.update_record(rid, {bpm_field: FAIL_SENTINEL, fields["quality_notes"]: "analysis failed"})
                        except Exception: pass
                    failed += 1
                    continue

                log.info(f"  {name}: BPM {analysis['bpm']} | {analysis['key']} | {analysis['mood']} | E{analysis['energy']} | Q{analysis['quality_score']}")
                if not args.dry_run:
                    fm.update_record(rid, build_fm_fields(analysis, cfg))
                done += 1
                time.sleep(0.05)
    finally:
        fm.logout()
        log.info(f"Done — analysed {done}, failed/skipped {failed}")


if __name__ == "__main__":
    main()
