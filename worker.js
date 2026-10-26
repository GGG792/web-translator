// 翻译推理 Worker：在后台线程加载模型和执行翻译，避免阻塞主线程导致界面卡死
import { pipeline, env } from './lib/transformers.min.js';

// 完全本地化：禁止远程下载，仅从本站点加载模型与 WASM 运行时
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = './models/';
env.backends.onnx.wasm.wasmPaths = './lib/';

const MODELS = {
  'zh-en': 'Xenova/opus-mt-zh-en',
  'en-zh': 'Xenova/opus-mt-en-zh',
  'ru-en': 'Xenova/opus-mt-ru-en',
  'en-ru': 'Xenova/opus-mt-en-ru',
};

// 翻译链：俄↔中无直接模型，经由英语中转
const CHAINS = {
  'zh-en': ['zh-en'],
  'en-zh': ['en-zh'],
  'ru-en': ['ru-en'],
  'en-ru': ['en-ru'],
  'ru-zh': ['ru-en', 'en-zh'],
  'zh-ru': ['zh-en', 'en-ru'],
};

const pipes = {};

function post(type, data) {
  self.postMessage({ type, ...data });
}

async function getPipe(pair) {
  if (!pipes[pair]) {
    pipes[pair] = (async () => {
      const fileProgress = {};
      return await pipeline('translation', MODELS[pair], {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.file) {
            fileProgress[p.file] = p.progress || 0;
            const vals = Object.values(fileProgress);
            const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
            post('progress', { pair, file: p.file, fileProgress: p.progress || 0, avg });
          } else if (p.status === 'initiate' || p.status === 'done') {
            post('file', { pair, status: p.status, file: p.file });
          }
        },
      });
    })();
    // 加载失败时清除缓存，允许重试
    pipes[pair].catch(() => { delete pipes[pair]; });
  }
  return pipes[pair];
}

// 预加载某个翻译方向所需的全部模型
async function preload(direction) {
  for (const pair of CHAINS[direction]) {
    post('status', { text: `加载模型 ${pair}…` });
    await getPipe(pair);
  }
  post('ready', { direction });
}

self.onmessage = async (e) => {
  const { type, id, direction, text } = e.data;
  try {
    if (type === 'load') {
      await preload(direction);
    } else if (type === 'translate') {
      let cur = text;
      const chain = CHAINS[direction];
      for (let i = 0; i < chain.length; i++) {
        const pair = chain[i];
        const pipe = await getPipe(pair);
        post('status', { text: chain.length > 1 ? `翻译中（${i + 1}/${chain.length} 段中转）…` : '翻译中…' });
        const out = await pipe(cur, { max_new_tokens: 256 });
        cur = out[0].translation_text;
      }
      post('result', { id, text: cur });
    }
  } catch (err) {
    post('error', { id, message: err && err.message ? err.message : String(err) });
  }
};
