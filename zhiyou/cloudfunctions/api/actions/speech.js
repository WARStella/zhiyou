'use strict';

const { assert, CODES } = require('../lib/errors');
const resp = require('../lib/resp');
const C = require('../lib/repo/collections');
const { createSpeechProvider, MAX_AUDIO_BYTES } = require('../lib/speech/tencent');

async function recognize(ctx) {
  const p = ctx.payload || {};
  assert(p.format === 'mp3', CODES.INVALID_PARAM, '仅支持本次录制的 MP3 语音');
  assert(Number.isFinite(p.durationMs) && p.durationMs >= 300 && p.durationMs <= 60000,
    CODES.INVALID_PARAM, '录音须为 0.3—60 秒');
  const encoded = p.audioBase64;
  assert(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= Math.ceil(MAX_AUDIO_BYTES / 3) * 4 &&
    encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), CODES.INVALID_PARAM, '音频格式错误或超过 512KB');
  const audio = Buffer.from(encoded, 'base64');
  assert(audio.length > 0 && audio.length <= MAX_AUDIO_BYTES && audio.toString('base64') === encoded,
    CODES.INVALID_PARAM, '音频编码无效');
  // 拒绝任意 URL 和伪造的音频格式；不向外部服务传用户身份或客户端 URL。
  const mp3 = audio.slice(0, 3).toString('ascii') === 'ID3' ||
    (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0 && (audio[1] & 6) !== 0 && (audio[1] & 0x18) !== 8);
  assert(mp3, CODES.INVALID_PARAM, '录音不是有效 MP3 文件');
  const now = new Date(ctx.now || Date.now());
  const recent = await ctx.repo.find(C.EVENTS, { action: 'speech.recognize', userId: ctx.openid,
    type: 'api_call' }, { sort: { ts: -1 }, limit: 10 });
  assert(recent.filter(e => new Date(e.ts).getTime() >= now.getTime() - 60000).length < 10,
    CODES.RATE_LIMITED, '语音请求过于频繁，请一分钟后重试');
  const provider = (ctx.createSpeechProvider || createSpeechProvider)();
  const result = await provider.recognize(audio, now);
  return resp.ok({ text: result.text, provider: result.provider });
}

async function session(ctx) {
  const now = new Date(ctx.now || Date.now());
  const recent = await ctx.repo.find(C.EVENTS, { action: 'speech.session', userId: ctx.openid,
    type: 'api_call' }, { sort: { ts: -1 }, limit: 10 });
  assert(recent.filter(e => new Date(e.ts).getTime() >= now.getTime() - 60000).length < 10,
    CODES.RATE_LIMITED, '语音请求过于频繁，请一分钟后重试');
  // 不接受客户端指定引擎、域名、账号、签名参数或延长有效期。
  const provider = (ctx.createSpeechProvider || createSpeechProvider)();
  return resp.ok(await provider.createSession(now));
}

module.exports = { recognize, session };
