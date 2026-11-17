import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateLocalProviderUrl } from '../url-validation.ts';
import type {
  AudioDiscoveryResult,
  AudioEngineInfo,
  AudioModelOption,
} from '../types.ts';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 15_000;
let cachedDiscovery: AudioDiscoveryResult | null = null;
let cachedAt = 0;

function expandHome(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableInPath(candidates: string[]): string | undefined {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      const resolved = path.resolve(expandHome(candidate));
      if (isExecutableFile(resolved)) return resolved;
      continue;
    }
    for (const dir of dirs) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return undefined;
}

function scanFilesInDirs(
  dirs: string[],
  extensions: string[],
  maxDepth = 2,
): AudioModelOption[] {
  const results: AudioModelOption[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (extensions.some((ext) => lower.endsWith(ext))) {
          try {
            const stat = fs.statSync(full);
            if (stat.size > 0 && !seen.has(full)) {
              seen.add(full);
              results.push({
                id: full,
                name: entry.name,
                path: full,
                sizeBytes: stat.size,
              });
            }
          } catch {
            // Ignore unreadable file
          }
        }
      }
    }
  };

  for (const rawDir of dirs) {
    if (!rawDir) continue;
    const resolved = path.resolve(expandHome(rawDir));
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile() && stat.size > 0) {
        const lower = resolved.toLowerCase();
        if (extensions.some((ext) => lower.endsWith(ext)) && !seen.has(resolved)) {
          seen.add(resolved);
          results.push({
            id: resolved,
            name: path.basename(resolved),
            path: resolved,
            sizeBytes: stat.size,
          });
        }
      } else if (stat.isDirectory()) {
        walk(resolved, 0);
      }
    } catch {
      // Directory or file does not exist
    }
  }

  return results;
}

function scanFasterWhisperModels(dirs: string[]): AudioModelOption[] {
  const results: AudioModelOption[] = [];
  const seen = new Set<string>();

  const addIfValidDir = (dirPath: string, label?: string) => {
    const modelBin = path.join(dirPath, 'model.bin');
    try {
      const stat = fs.statSync(modelBin);
      if (stat.isFile() && stat.size > 0 && !seen.has(dirPath)) {
        seen.add(dirPath);
        results.push({
          id: dirPath,
          name: label || path.basename(dirPath),
          path: dirPath,
          sizeBytes: stat.size,
        });
      }
    } catch {
      // Not a CTranslate2 model directory
    }
  };

  for (const raw of dirs) {
    if (!raw) continue;
    const resolved = path.resolve(expandHome(raw));
    if (!fs.existsSync(resolved)) continue;
    addIfValidDir(resolved);

    try {
      for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(resolved, entry.name);
        addIfValidDir(sub, entry.name);
        if (entry.name.startsWith('models--') && entry.name.includes('faster-whisper')) {
          const snapshotsDir = path.join(sub, 'snapshots');
          if (fs.existsSync(snapshotsDir)) {
            for (const snap of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
              if (snap.isDirectory()) {
                addIfValidDir(
                  path.join(snapshotsDir, snap.name),
                  entry.name.replace('models--Systran--', ''),
                );
              }
            }
          }
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  return results;
}

async function checkPythonModule(
  pythonBin: string | undefined,
  moduleName: string,
): Promise<boolean> {
  if (!pythonBin) return false;
  try {
    await execFileAsync(pythonBin, ['-c', `import ${moduleName}`], {
      timeout: 2500,
    });
    return true;
  } catch {
    return false;
  }
}

async function probeHttpService(
  baseUrl: string,
  paths: string[],
): Promise<{ reachable: boolean; jsonBody?: unknown; error?: string }> {
  for (const subPath of paths) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const resp = await fetch(`${baseUrl}${subPath}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        const jsonBody = ct.includes('json') ? await resp.json().catch(() => undefined) : undefined;
        return { reachable: true, jsonBody };
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      if (subPath === paths[paths.length - 1]) {
        return {
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  return { reachable: false, error: 'HTTP service did not respond OK.' };
}

async function detectWhisperCpp(): Promise<AudioEngineInfo> {
  const customBin = (process.env.WHISPER_CPP_BIN || '').trim();
  const binPath = findExecutableInPath(
    customBin ? [customBin] : ['whisper-cli', 'whisper-cpp', 'whisper', 'main'],
  );

  const modelDirs = [
    process.env.WHISPER_CPP_MODEL || '',
    process.env.WHISPER_MODELS_DIR || '',
    './models/whisper',
    '~/.cache/whisper',
    '/usr/local/share/whisper',
  ];
  const models = scanFilesInDirs(modelDirs, ['.bin']);

  const installed = Boolean(binPath);
  const available = Boolean(binPath && models.length > 0);

  let statusMessage = '';
  if (!installed) {
    statusMessage = 'Not installed (whisper-cli / whisper-cpp binary not found on server)';
  } else if (models.length === 0) {
    statusMessage = `Binary found (${path.basename(binPath!)}) • No .bin model files found`;
  } else {
    statusMessage = `Ready • ${models.length} model(s) on server`;
  }

  return {
    id: 'whisper.cpp',
    kind: 'stt',
    name: 'Whisper.cpp (Local)',
    hosting: 'local',
    installed,
    available,
    statusMessage,
    binaryPath: binPath,
    models,
    installHint:
      'Install whisper.cpp (`whisper-cli`) and set WHISPER_CPP_BIN / WHISPER_CPP_MODEL on the server.',
  };
}

async function detectFasterWhisper(pythonBin: string | undefined): Promise<AudioEngineInfo> {
  const pkgInstalled = await checkPythonModule(pythonBin, 'faster_whisper');
  const modelDirs = [
    process.env.FASTER_WHISPER_MODEL || '',
    process.env.WHISPER_MODELS_DIR || '',
    './models/faster-whisper',
    '~/.cache/huggingface/hub',
  ];
  const models = scanFasterWhisperModels(modelDirs);

  const available = pkgInstalled && models.length > 0;
  let statusMessage = '';
  if (!pkgInstalled) {
    statusMessage = 'Not installed (Python faster_whisper package not found on server)';
  } else if (models.length === 0) {
    statusMessage = 'faster_whisper installed • No local CTranslate2 model directory found';
  } else {
    statusMessage = `Ready • ${models.length} local model(s)`;
  }

  return {
    id: 'faster-whisper',
    kind: 'stt',
    name: 'Faster-Whisper (Local)',
    hosting: 'local',
    installed: pkgInstalled,
    available,
    statusMessage,
    binaryPath: pkgInstalled ? pythonBin : undefined,
    models,
    installHint:
      'Install `faster-whisper` in Python and set FASTER_WHISPER_MODEL to a local CTranslate2 model directory.',
  };
}

async function detectWhisperHttp(): Promise<AudioEngineInfo> {
  const rawUrl = (process.env.LOCAL_STT_URL || '').trim();
  if (!rawUrl) {
    return {
      id: 'whisper-http',
      kind: 'stt',
      name: 'Local Whisper HTTP',
      hosting: 'local',
      installed: false,
      available: false,
      statusMessage: 'Not configured (set LOCAL_STT_URL on server)',
      models: [],
      installHint: 'Run a local Whisper HTTP server and set LOCAL_STT_URL=http://127.0.0.1:8000.',
    };
  }

  const validation = validateLocalProviderUrl(rawUrl, 'LOCAL_STT_URL');
  if (!validation.valid || !validation.normalizedUrl) {
    return {
      id: 'whisper-http',
      kind: 'stt',
      name: 'Local Whisper HTTP',
      hosting: 'local',
      installed: false,
      available: false,
      statusMessage: validation.error || 'Invalid LOCAL_STT_URL',
      models: [],
    };
  }

  const probe = await probeHttpService(validation.normalizedUrl, ['/health', '/v1/models', '/']);
  const models: AudioModelOption[] = [];
  if (probe.reachable && probe.jsonBody && typeof probe.jsonBody === 'object') {
    const data = (probe.jsonBody as { data?: Array<{ id?: string }>; models?: string[] });
    if (Array.isArray(data.data)) {
      for (const item of data.data) {
        if (item.id) models.push({ id: item.id, name: item.id });
      }
    } else if (Array.isArray(data.models)) {
      for (const m of data.models) {
        models.push({ id: m, name: m });
      }
    }
  }
  if (probe.reachable && models.length === 0) {
    models.push({ id: 'whisper-1', name: 'Default HTTP Whisper Model' });
  }

  return {
    id: 'whisper-http',
    kind: 'stt',
    name: 'Local Whisper HTTP',
    hosting: 'local',
    installed: true,
    available: probe.reachable,
    statusMessage: probe.reachable
      ? `Connected at ${validation.normalizedUrl}`
      : `Service unreachable at ${validation.normalizedUrl}`,
    serviceUrl: validation.normalizedUrl,
    models,
    installHint: 'Start your Whisper HTTP daemon at LOCAL_STT_URL.',
  };
}

async function detectPiper(): Promise<AudioEngineInfo> {
  const customBin = (process.env.PIPER_BIN || '').trim();
  const binPath = findExecutableInPath(customBin ? [customBin] : ['piper', 'piper-tts']);

  const voiceDirs = [
    process.env.PIPER_MODEL || '',
    process.env.PIPER_VOICES_DIR || '',
    './models/piper',
    '~/.local/share/piper',
    '/usr/share/piper',
  ];
  const models = scanFilesInDirs(voiceDirs, ['.onnx']);

  const installed = Boolean(binPath);
  const available = Boolean(binPath && models.length > 0);

  let statusMessage = '';
  if (!installed) {
    statusMessage = 'Not installed (piper binary not found on server)';
  } else if (models.length === 0) {
    statusMessage = `Binary found (${path.basename(binPath!)}) • No .onnx voice files found`;
  } else {
    statusMessage = `Ready • ${models.length} voice(s)`;
  }

  return {
    id: 'piper',
    kind: 'tts',
    name: 'Piper TTS (Local)',
    hosting: 'local',
    installed,
    available,
    statusMessage,
    binaryPath: binPath,
    models,
    installHint: 'Install Piper TTS and place .onnx + .onnx.json voice files in PIPER_VOICES_DIR.',
  };
}

async function detectKokoro(pythonBin: string | undefined): Promise<AudioEngineInfo> {
  const rawUrl = (process.env.KOKORO_URL || '').trim();
  if (rawUrl) {
    const validation = validateLocalProviderUrl(rawUrl, 'KOKORO_URL');
    if (!validation.valid || !validation.normalizedUrl) {
      return {
        id: 'kokoro',
        kind: 'tts',
        name: 'Kokoro TTS (Local)',
        hosting: 'local',
        installed: false,
        available: false,
        statusMessage: validation.error || 'Invalid KOKORO_URL',
        models: [],
      };
    }

    const probe = await probeHttpService(validation.normalizedUrl, ['/v1/audio/voices', '/health']);
    const models: AudioModelOption[] = [];
    if (probe.reachable && probe.jsonBody && typeof probe.jsonBody === 'object') {
      const voices = (probe.jsonBody as { voices?: string[] }).voices;
      if (Array.isArray(voices)) {
        for (const v of voices) {
          models.push({ id: v, name: v });
        }
      }
    }
    if (probe.reachable && models.length === 0) {
      for (const fallbackVoice of ['af_bella', 'af_heart', 'af_sarah', 'bf_emma']) {
        models.push({ id: fallbackVoice, name: fallbackVoice });
      }
    }

    return {
      id: 'kokoro',
      kind: 'tts',
      name: 'Kokoro TTS (Local)',
      hosting: 'local',
      installed: true,
      available: probe.reachable,
      statusMessage: probe.reachable
        ? `Connected at ${validation.normalizedUrl} • ${models.length} voice(s)`
        : `Kokoro service unreachable at ${validation.normalizedUrl}`,
      serviceUrl: validation.normalizedUrl,
      models,
      installHint: 'Start Kokoro-FastAPI or local Kokoro server at KOKORO_URL.',
    };
  }

  const hasKokoroOnnx = await checkPythonModule(pythonBin, 'kokoro_onnx');
  const modelFiles = scanFilesInDirs(
    [process.env.KOKORO_MODEL || '', './models/kokoro', '~/.cache/kokoro'],
    ['.onnx'],
  );
  const voiceFiles = scanFilesInDirs(
    [process.env.KOKORO_VOICES || '', './models/kokoro', '~/.cache/kokoro'],
    ['.bin', '.npz'],
  );

  const available = hasKokoroOnnx && modelFiles.length > 0 && voiceFiles.length > 0;
  let statusMessage = '';
  if (!hasKokoroOnnx) {
    statusMessage = 'Not installed (KOKORO_URL not set and kokoro_onnx Python package missing)';
  } else if (modelFiles.length === 0 || voiceFiles.length === 0) {
    statusMessage = 'kokoro_onnx installed • Missing local .onnx model or voices file';
  } else {
    statusMessage = `Ready • Local Kokoro ONNX`;
  }

  return {
    id: 'kokoro',
    kind: 'tts',
    name: 'Kokoro TTS (Local)',
    hosting: 'local',
    installed: hasKokoroOnnx,
    available,
    statusMessage,
    binaryPath: hasKokoroOnnx ? pythonBin : undefined,
    models: available
      ? [
          { id: 'af_bella', name: 'af_bella (Female)', path: modelFiles[0]?.path },
          { id: 'af_heart', name: 'af_heart (Female)', path: modelFiles[0]?.path },
        ]
      : [],
    installHint:
      'Run Kokoro HTTP server with KOKORO_URL=http://127.0.0.1:8880 or install kokoro-onnx with local model files.',
  };
}

async function detectPiperHttp(): Promise<AudioEngineInfo> {
  const rawUrl = (process.env.LOCAL_TTS_URL || '').trim();
  if (!rawUrl) {
    return {
      id: 'piper-http',
      kind: 'tts',
      name: 'Local TTS HTTP',
      hosting: 'local',
      installed: false,
      available: false,
      statusMessage: 'Not configured (set LOCAL_TTS_URL on server)',
      models: [],
      installHint: 'Run a local Piper HTTP server and set LOCAL_TTS_URL=http://127.0.0.1:5000.',
    };
  }

  const validation = validateLocalProviderUrl(rawUrl, 'LOCAL_TTS_URL');
  if (!validation.valid || !validation.normalizedUrl) {
    return {
      id: 'piper-http',
      kind: 'tts',
      name: 'Local TTS HTTP',
      hosting: 'local',
      installed: false,
      available: false,
      statusMessage: validation.error || 'Invalid LOCAL_TTS_URL',
      models: [],
    };
  }

  const probe = await probeHttpService(validation.normalizedUrl, ['/voices', '/health', '/']);
  const models: AudioModelOption[] = [];
  if (probe.reachable && probe.jsonBody && typeof probe.jsonBody === 'object') {
    const obj = probe.jsonBody as Record<string, unknown>;
    if (Array.isArray(obj.voices)) {
      for (const v of obj.voices) {
        if (typeof v === 'string') models.push({ id: v, name: v });
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (key !== 'status' && key !== 'ok') {
          models.push({ id: key, name: key });
        }
      }
    }
  }
  if (probe.reachable && models.length === 0) {
    models.push({ id: 'default', name: 'Default HTTP Voice' });
  }

  return {
    id: 'piper-http',
    kind: 'tts',
    name: 'Local TTS HTTP',
    hosting: 'local',
    installed: true,
    available: probe.reachable,
    statusMessage: probe.reachable
      ? `Connected at ${validation.normalizedUrl}`
      : `Service unreachable at ${validation.normalizedUrl}`,
    serviceUrl: validation.normalizedUrl,
    models,
    installHint: 'Start your local TTS HTTP daemon at LOCAL_TTS_URL.',
  };
}

export async function discoverAudioEngines(forceRefresh = false): Promise<AudioDiscoveryResult> {
  if (!forceRefresh && cachedDiscovery && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedDiscovery;
  }

  const pythonBin = findExecutableInPath(
    process.env.WHISPER_PYTHON_BIN
      ? [process.env.WHISPER_PYTHON_BIN]
      : ['python3', 'python'],
  );

  const [whisperCpp, fasterWhisper, whisperHttp, piper, kokoro, piperHttp] =
    await Promise.all([
      detectWhisperCpp(),
      detectFasterWhisper(pythonBin),
      detectWhisperHttp(),
      detectPiper(),
      detectKokoro(pythonBin),
      detectPiperHttp(),
    ]);

  const result: AudioDiscoveryResult = {
    stt: [whisperCpp, fasterWhisper, whisperHttp],
    tts: [piper, kokoro, piperHttp],
    checkedAt: new Date().toISOString(),
    runtimeNote:
      'Local STT/TTS engines and Ollama run on the Vivica backend server host. Browser clients in a remote cloud preview cannot access your desktop localhost binaries unless the backend itself runs locally or connects via an allowed tunnel/host.',
  };

  cachedDiscovery = result;
  cachedAt = Date.now();
  return result;
}

async function normalizeAudioToWav(
  inputBuffer: Buffer,
  mimeType: string,
  tempDir: string,
): Promise<string> {
  const lower = (mimeType || '').toLowerCase();
  const ext = lower.includes('webm')
    ? 'webm'
    : lower.includes('ogg')
      ? 'ogg'
      : lower.includes('mp4') || lower.includes('m4a')
        ? 'm4a'
        : lower.includes('wav')
          ? 'wav'
          : 'bin';

  const inputPath = path.join(tempDir, `input.${ext}`);
  const wavPath = path.join(tempDir, 'normalized.wav');
  fs.writeFileSync(inputPath, inputBuffer);

  const ffmpegBin = findExecutableInPath(['ffmpeg']);
  if (!ffmpegBin) {
    if (ext === 'wav') return inputPath;
    throw new Error('ffmpeg is required on the server to convert recorded audio to 16kHz WAV.');
  }

  await execFileAsync(
    ffmpegBin,
    ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
    { timeout: 15_000 },
  );
  return wavPath;
}

export async function transcribeAudio(params: {
  engineId: string;
  model?: string;
  audioBase64: string;
  mimeType?: string;
}): Promise<{ text: string; engineId: string; model?: string }> {
  const discovery = await discoverAudioEngines(false);
  const engine = discovery.stt.find((e) => e.id === params.engineId);
  if (!engine) {
    throw new Error(`Unknown STT engine: ${params.engineId}`);
  }
  if (!engine.available) {
    throw new Error(engine.statusMessage || `STT engine "${params.engineId}" is not available.`);
  }

  const audioBuffer = Buffer.from(params.audioBase64, 'base64');
  if (audioBuffer.length === 0) {
    throw new Error('Empty audio payload.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivica-stt-'));
  try {
    const wavPath = await normalizeAudioToWav(
      audioBuffer,
      params.mimeType || 'audio/webm',
      tempDir,
    );

    if (engine.id === 'whisper-http' && engine.serviceUrl) {
      const wavBytes = fs.readFileSync(wavPath);
      const form = new FormData();
      form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');
      if (params.model) {
        form.append('model', params.model);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const resp = await fetch(`${engine.serviceUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          throw new Error(`Whisper HTTP returned ${resp.status}: ${detail.slice(0, 150)}`);
        }
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const json = (await resp.json()) as { text?: string };
          return { text: (json.text || '').trim(), engineId: engine.id, model: params.model };
        }
        const text = await resp.text();
        return { text: text.trim(), engineId: engine.id, model: params.model };
      } finally {
        clearTimeout(timer);
      }
    }

    const selectedModel =
      engine.models.find((m) => m.id === params.model || m.name === params.model) ||
      engine.models[0];
    if (!selectedModel?.path) {
      throw new Error(`No valid model file found for STT engine "${engine.id}".`);
    }

    if (engine.id === 'whisper.cpp' && engine.binaryPath) {
      const { stdout } = await execFileAsync(
        engine.binaryPath,
        ['-m', selectedModel.path, '-f', wavPath, '--no-timestamps', '-nt'],
        { timeout: 30_000 },
      );
      return {
        text: stdout.trim(),
        engineId: engine.id,
        model: selectedModel.name,
      };
    }

    if (engine.id === 'faster-whisper' && engine.binaryPath) {
      const pyScript = [
        'import sys',
        'from faster_whisper import WhisperModel',
        'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")',
        'segments, _ = model.transcribe(sys.argv[2])',
        'print(" ".join(s.text.strip() for s in segments).strip())',
      ].join('\n');

      const { stdout } = await execFileAsync(
        engine.binaryPath,
        ['-c', pyScript, selectedModel.path, wavPath],
        { timeout: 45_000 },
      );
      return {
        text: stdout.trim(),
        engineId: engine.id,
        model: selectedModel.name,
      };
    }

    throw new Error(`STT execution is not configured for "${engine.id}".`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runProcessWithStdin(
  command: string,
  args: string[],
  stdinText: string,
  timeoutMs = 25_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`TTS process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`TTS process exited with code ${code}: ${stderr.slice(0, 200)}`));
      }
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

export async function synthesizeSpeech(params: {
  engineId: string;
  voice?: string;
  text: string;
}): Promise<{ audioBuffer: Buffer; contentType: string }> {
  const cleanText = params.text.trim().slice(0, 4000);
  if (!cleanText) {
    throw new Error('Text for synthesis cannot be empty.');
  }

  const discovery = await discoverAudioEngines(false);
  const engine = discovery.tts.find((e) => e.id === params.engineId);
  if (!engine) {
    throw new Error(`Unknown TTS engine: ${params.engineId}`);
  }
  if (!engine.available) {
    throw new Error(engine.statusMessage || `TTS engine "${params.engineId}" is not available.`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivica-tts-'));
  try {
    if (engine.id === 'piper' && engine.binaryPath) {
      const selectedVoice =
        engine.models.find((m) => m.id === params.voice || m.name === params.voice) ||
        engine.models[0];
      if (!selectedVoice?.path) {
        throw new Error('No Piper .onnx voice file available on server.');
      }
      const outWav = path.join(tempDir, 'speech.wav');
      await runProcessWithStdin(
        engine.binaryPath,
        ['--model', selectedVoice.path, '--output_file', outWav],
        cleanText,
      );
      return {
        audioBuffer: fs.readFileSync(outWav),
        contentType: 'audio/wav',
      };
    }

    if (engine.id === 'piper-http' && engine.serviceUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        let resp = await fetch(`${engine.serviceUrl}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: cleanText,
            voice: params.voice || engine.models[0]?.id,
          }),
          signal: controller.signal,
        });
        if (resp.status === 404) {
          resp = await fetch(`${engine.serviceUrl}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: cleanText,
              voice: params.voice || engine.models[0]?.id,
            }),
            signal: controller.signal,
          });
        }
        clearTimeout(timer);
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          throw new Error(`TTS HTTP returned ${resp.status}: ${detail.slice(0, 140)}`);
        }
        const arrayBuf = await resp.arrayBuffer();
        return {
          audioBuffer: Buffer.from(arrayBuf),
          contentType: resp.headers.get('content-type') || 'audio/wav',
        };
      } finally {
        clearTimeout(timer);
      }
    }

    if (engine.id === 'kokoro') {
      if (engine.serviceUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25_000);
        try {
          const resp = await fetch(`${engine.serviceUrl}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'kokoro',
              input: cleanText,
              voice: params.voice || engine.models[0]?.id || 'af_bella',
              response_format: 'wav',
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`Kokoro HTTP returned ${resp.status}: ${detail.slice(0, 140)}`);
          }
          const arrayBuf = await resp.arrayBuffer();
          return {
            audioBuffer: Buffer.from(arrayBuf),
            contentType: resp.headers.get('content-type') || 'audio/wav',
          };
        } finally {
          clearTimeout(timer);
        }
      }

      if (engine.binaryPath) {
        const modelFiles = scanFilesInDirs(
          [process.env.KOKORO_MODEL || '', './models/kokoro', '~/.cache/kokoro'],
          ['.onnx'],
        );
        const voiceFiles = scanFilesInDirs(
          [process.env.KOKORO_VOICES || '', './models/kokoro', '~/.cache/kokoro'],
          ['.bin', '.npz'],
        );
        if (!modelFiles[0]?.path || !voiceFiles[0]?.path) {
          throw new Error('Kokoro ONNX model or voice pack files missing.');
        }
        const outWav = path.join(tempDir, 'kokoro.wav');
        const pyScript = [
          'import sys, wave, numpy as np',
          'from kokoro_onnx import Kokoro',
          'kokoro = Kokoro(sys.argv[1], sys.argv[2])',
          'samples, sr = kokoro.create(sys.argv[3], voice=sys.argv[4], speed=1.0, lang="en-us")',
          'pcm = np.clip(samples * 32767, -32768, 32767).astype(np.int16)',
          'with wave.open(sys.argv[5], "wb") as wf:',
          '    wf.setnchannels(1)',
          '    wf.setsampwidth(2)',
          '    wf.setframerate(int(sr))',
          '    wf.writeframes(pcm.tobytes())',
        ].join('\n');

        await execFileAsync(
          engine.binaryPath,
          [
            '-c',
            pyScript,
            modelFiles[0].path,
            voiceFiles[0].path,
            cleanText,
            params.voice || 'af_bella',
            outWav,
          ],
          { timeout: 30_000 },
        );
        return {
          audioBuffer: fs.readFileSync(outWav),
          contentType: 'audio/wav',
        };
      }
    }

    throw new Error(`TTS execution is not configured for "${engine.id}".`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
