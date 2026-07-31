import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Supply-chain guard (2026-07-31).
//
// lib/semantic-shelves.js reads `index_info.model` out of a SQLite file that the
// service DOWNLOADS over the network (SEMANTIC_DB_URL). transformers.js resolves
// an unknown model name by fetching it from the Hugging Face Hub and handing the
// resulting .onnx to onnxruntime-node — a native runtime. Without an allowlist,
// the contents of a downloaded file decide what code this service pulls in and
// executes, and the model is re-fetched from the Hub on every deploy because the
// transformers cache lives in gitignored node_modules.

let src;

beforeAll(async () => {
  src = await readFile(path.resolve('lib/semantic-shelves.js'), 'utf8');
});

describe('embedding model must come from an allowlist', () => {
  it('defines an allowlist with the expected model as the default', () => {
    expect(src).toMatch(/ALLOWED_EMBED_MODELS/);
    expect(src).toContain('Xenova/multilingual-e5-small');
  });

  it('checks the allowlist before calling pipeline()', () => {
    const guard = src.indexOf('ALLOWED_EMBED_MODELS.has(info.model)');
    const call = src.indexOf("pipeline('feature-extraction', info.model");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);   // guard must precede the load
  });

  it('fails closed rather than loading an unexpected model', () => {
    const block = src.slice(
      src.indexOf('ALLOWED_EMBED_MODELS.has(info.model)'),
      src.indexOf("pipeline('feature-extraction', info.model")
    );
    expect(block).toMatch(/_ready\s*=\s*false/);
    expect(block).toMatch(/return false/);
  });

  it('allowlist semantics: exact membership, not substring', () => {
    // A Set + .has() is exact. Guard against someone "relaxing" this to includes().
    expect(src).toMatch(/ALLOWED_EMBED_MODELS\s*=\s*new Set\(/);
    expect(src).not.toMatch(/ALLOWED_EMBED_MODELS\.some\(|info\.model\.includes\(/);
  });
});

describe('builds must be lockfile-exact', () => {
  it('render.yaml uses npm ci, never npm install', async () => {
    const render = await readFile(path.resolve('render.yaml'), 'utf8');
    const commands = render.split('\n').filter((l) => l.includes('buildCommand'));
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands) {
      expect(line).not.toMatch(/npm\s+install/);
      expect(line).toMatch(/npm\s+ci/);
    }
  });

  it('pins @huggingface/transformers exactly (no caret)', async () => {
    const pkg = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
    expect(pkg.dependencies['@huggingface/transformers']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
