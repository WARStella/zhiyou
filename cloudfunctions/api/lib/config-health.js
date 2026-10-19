'use strict';

const { normalizeKey } = require('./amap/key');
const { realtimeConfigured } = require('./speech/realtime');
const { config: guideConfig } = require('./guide/provider');

/** 只检查配置，不发请求；配了 Key 不能冒充已经验证上游连通性。 */
function dependencyStatus(env) {
  const e = env || process.env;
  const configured = value => Boolean(value && String(value).trim());
  const amapConfigured = Boolean(normalizeKey(e.AMAP_KEY).key);
  const describe = (provider, ready, probeAction, hint) => ({
    provider, configured: ready, check: 'configuration_only',
    connectivity: 'not_probed', probeAction, hint: ready ? null : hint,
  });
  const map = e.MAP_PROVIDER || 'tencent';
  const photo = e.PHOTO_PROVIDER || 'amap';
  const guideText = guideConfig(e, false), guideVision = guideConfig(e, true);
  return {
    mapService: describe(map, map === 'fake' || (map === 'tencent' && configured(e.MAP_KEY)),
      'map.probe', '配置腾讯 WebService MAP_KEY，并核对 MAP_PROVIDER'),
    transitService: describe('amap-transit', amapConfigured, 'transit.probe',
      '配置高德 Web服务 AMAP_KEY；公交与地铁共用一次公交规划请求'),
    photoService: describe(photo, photo === 'fake' || (photo === 'amap' && amapConfigured),
      'photo.probe', '配置高德 Web服务 AMAP_KEY，并核对 PHOTO_PROVIDER'),
    llm: Object.assign(describe('http', configured(e.AI_API_KEY), 'ai.probe',
      'AI_API_KEY 未配置，需求解析会使用规则降级'), { fallback: 'rulebased' }),
    speechService: describe('tencent-asr-realtime', realtimeConfigured(e), null,
      '配置 ASR_APP_ID / ASR_SECRET_ID / ASR_SECRET_KEY，开通实时语音识别；ASR_SESSION_TOKEN 留空。实际真机录音验证连通性'),
    locationApi: { check: 'client_only', status: 'not_checked',
      hint: '由小程序检查微信定位权限；云端健康检查不代表设备已授权' },
    ocrService: describe('tencent-ocr', configured(e.OCR_SECRET_ID) && configured(e.OCR_SECRET_KEY), null,
      '配置 OCR_SECRET_ID / OCR_SECRET_KEY，并开通 GeneralBasicOCR；实际选图识别验证连通性'),
    guideService: { ...describe('bounded-guide-agent', guideText.available, null,
      '默认 DeepSeek：配置 AI_API_KEY 或 GUIDE_DEEPSEEK_API_KEY 为 DeepSeek 官方 Key；其他兼容接口须显式设置 GUIDE_PROVIDER=compatible'),
      modelProvider: guideText.provider, textModel: guideText.model,
      visionConfigured: guideVision.available, visionModel: guideVision.model,
      knowledgeVersion: require('./guide/knowledge').KNOWLEDGE_VERSION },
    crowdService: describe('yolo', require('./guide/crowd').crowdConfig(e).available, null,
      '部署 services/crowd 的 YOLO 推理服务，配置 YOLO_BASE_URL 和 YOLO_API_KEY；此检查不代表已完成真实推理'),
    /**
     * 订阅消息（2026-10-17）。
     *
     * ⚠️ 它**不需要环境变量**：发送走 `cloud.openapi` 云调用，密钥由云开发代持。
     * 所以这里的"配置"是两件代码之外的事，健康检查只能如实标注它们没被验证：
     *   ① `api/config.json` 的 `permissions.openapi` 要登记 `subscribeMessage.send`；
     *   ② 三个模板要已经在用户小程序后台启用。
     * 这两条任何一条不满足，发送会以"没有权限/模板不存在"失败，
     * 而那种失败**不会**在本地测试里暴露（本地用的是替身）。
     */
    subscribeMessage: {
      provider: 'cloud-openapi',
      check: 'config_file_and_backend',
      connectivity: 'not_probed',
      configured: null,
      probeAction: null,
      templates: require('./subscribe/templates').describeTemplates().map(t => ({
        kind: t.kind, label: t.label,
      })),
      hint: '在 api/config.json 的 permissions.openapi 登记 subscribeMessage.send，' +
        '并确认三个模板已在小程序后台启用；实际送达需真机授权后核验，健康检查不代表已发送成功',
    },
  };
}

module.exports = { dependencyStatus };
