'use strict';

/**
 * 高德地图 POI 照片 provider —— **按地点名字检索**。
 *
 * ── 为什么是高德（2026-10-14 核查结论）────────────────────
 *
 * 本项目原先只依赖腾讯位置服务，而**腾讯没有任何接口能返回 POI 照片**：
 * 官方 sitemap 下 42 个 WebService 文档页整站扫过，`photo`/`照片` 命中为 0；
 * 「地点搜索」「POI 详情」「逆地址解析（get_poi=1）」的响应字段表都逐字看过；
 * 静态图 API 返回的是渲染好的地图图片本身，不是 POI 照片。
 *
 * 三家对照：
 *   · 腾讯  —— 无照片字段（穷尽核查）
 *   · 高德  —— `photos[].url`，**需 `show_fields=photos`**；文档未标注付费
 *   · 百度  —— 有 `photos`，但写明"获取POI图片为高级服务，购买商用授权可申请开通"
 *
 * ⚠️ 两个必须记进成本记录的点：
 *   ① 高德是**月**配额（个人认证 5,000/月），不是日配额；
 *   ② 免费额度原文限定"**非商业目的**"，商用需技术服务许可。
 *
 * ── 关于"按名字搜"的风险，以及本文件如何处理它 ──────────────
 *
 * 这个项目在"名字包含即相等"上栽过四次（民宿冒充「冰雪大世界」、
 * 「哈工大」→「哈工大[地铁站]」被当必去、一句话选出四个地方…）。
 * 按名字搜照片会踩同一个坑，而**照片比名字更糟**：一张错误的照片会让人
 * 按图去找，找错的代价是整队人等在原地。
 *
 * 所以名字检索保留，但结果必须过**两道检查**（`shared.judgeTrust`）：
 *
 *   ① **距离守卫**：照片所属 POI 与该点位坐标的距离必须 ≤ 300 米。
 *      超过就标 `trusted: false`，界面默认不展示。
 *      —— 名字可以骗人，位置不会。
 *   ② **名字比对**（宽松）：拦"完全不同的地方"，但允许后缀差异
 *      （「哈尔滨工业大学」vs「哈工大」）。
 *
 * 关键设计：**判不出来时一律按不可信处理**（`distance-unknown`）。
 * "无法确认"不等于"可信" —— 这是 §6.6「检索到资料 ≠ 资料可信」的直接落实。
 *
 * ⚠️ Key 只从**云函数环境变量** `AMAP_KEY` 读取，绝不写入代码或仓库。
 */

const { defaultTransport, redact, maskSecret } = require('../http');
const {
  parseLocation,
  extractPhotos,
  photosFieldVia,
  judgeTrust,
  nameMatches,
  explainEmpty,
} = require('./shared');

const DEFAULT_TEXT_BASE = 'https://restapi.amap.com/v5/place/text';
const DEFAULT_TIMEOUT_MS = 8000;
/** 默认检索城市 —— 本项目**单城**（哈尔滨），与 place.js 的 DEFAULT_REGION 一致 */
const DEFAULT_REGION = '哈尔滨';
/** 取上游前 N 条做名字比对，选出最像的那个 */
const CANDIDATE_WINDOW = 5;

/** 高德 status 码的常见成因（只写确证的几条，不编） */
function statusHint(status) {
  const hints = {
    '10001': 'Key 不正确或已过期 —— 检查云函数环境变量 AMAP_KEY',
    '10002': '没有请求权限 —— 该 Key 可能未开通「Web服务API」',
    '10003': '访问过于频繁 —— 已达 QPS 限制',
    '10004': '今日访问量已达上限',
    '10009': '请求 Key 与绑定平台不符 —— Key 需为「Web服务」类型',
    '10012': '权限不足 —— 该 Key 可能未开通此接口',
    '10021': 'QPS 超出限制',
    '20000': '请求参数错误',
    '20001': '缺少必填参数',
    '20003': '参数值非法',
  };
  return hints[String(status)] || null;
}

/**
 * Key 归一化 —— **去掉前后空白**。
 *
 * ⚠️ 这不是洁癖。腾讯那边已经踩过一次（见 `actions/map.js` 的说明：
 * "检测到 MAP_KEY 前后有多余空白（常见于从控制台表格复制）"）。
 * 从控制台表格里复制 Key 时，很容易连同一个空格或换行一起带走，
 * 而后果是上游返回 `10001 Key 不正确` —— **一个把人引向"Key 本身错了"的
 * 错误诊断**，实际上只是多了个空格。
 *
 * 去空白的同时把"是否去过空白"记下来，好在报错时说清是哪种情况。
 */
function normalizeKey(raw) {
  if (raw == null) return { key: '', trimmed: false, hadValue: false };
  const s = String(raw);
  const t = s.trim();
  return { key: t, trimmed: t !== s, hadValue: s.length > 0 };
}

function createAmapPhotoProvider(opts) {
  opts = opts || {};
  const rawKey = opts.key !== undefined ? opts.key : process.env.AMAP_KEY;
  const normalized = normalizeKey(rawKey);
  const key = normalized.key;
  const textBaseUrl = opts.textBaseUrl || DEFAULT_TEXT_BASE;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const http = opts.http || defaultTransport;

  return {
    name: 'amap',

    /** 确认"配没配"，**不泄露 Key 本身**；`trimmed` 用于解释"Key 明明配了却报 10001" */
    keyStatus() {
      return { configured: Boolean(key), masked: maskSecret(key), trimmed: normalized.trimmed };
    },

    /**
     * 按名字取某个地点的照片。
     *
     * @param {object} input
     * @param {string} input.name            地点名（用于检索 + 名字比对）
     * @param {object} [input.targetLocation] 该地点的坐标（用于距离守卫）
     * @param {string} [input.region]         检索城市，缺省哈尔滨
     * @param {number} [input.pageSize]       上游返回条数
     * @returns {Promise<object>} 恒返回结构，不抛异常 —— 照片取不到不该阻断主流程
     */
    async photosByName(input) {
      input = input || {};
      const name = input.name ? String(input.name).trim() : '';
      const region = input.region || DEFAULT_REGION;
      const targetLocation = input.targetLocation || null;
      /** 有坐标时把它当检索偏置 —— 只影响排序，不替代距离守卫 */
      const bias = targetLocation
        ? `${targetLocation.latitude},${targetLocation.longitude}`
        : null;

      const base = {
        provider: 'amap',
        operation: 'place/text',
        keyword: name || null,
        region,
        targetLocation,
      };

      if (!name) {
        return Object.assign(base, {
          ok: false,
          reason: 'NAME_REQUIRED',
          message: '按名字取照片必须给出 name',
          photos: [],
          emptyReason: 'NAME_REQUIRED',
        });
      }

      if (!key) {
        return Object.assign(base, {
          ok: false,
          reason: 'AMAP_KEY_NOT_CONFIGURED',
          message: '云函数环境变量 AMAP_KEY 未配置，无法取 POI 照片',
          hint: '云开发控制台 → 云函数 → api → 配置 → 环境变量 → 新增 AMAP_KEY（需「Web服务」类型 Key）',
          photos: [],
          emptyReason: 'PROVIDER_NOT_CONFIGURED',
        });
      }

      /**
       * ⚠️ `show_fields=photos` 是**必须的**。高德文档原文：
       * 「show_fields 未设置时，只返回基础信息类内字段」——
       * 漏掉这个参数不会报错，只会安静地不返回照片。
       */
      const requestUrl =
        `${textBaseUrl}?keywords=${encodeURIComponent(name)}` +
        `&region=${encodeURIComponent(region)}` +
        (bias ? `&location=${bias}` : '') +
        `&show_fields=photos` +
        `&page_size=${input.pageSize || CANDIDATE_WINDOW}&page_num=1` +
        `&key=${encodeURIComponent(key)}`;

      const safeUrl = redact(requestUrl);
      const started = Date.now();
      let res;
      try {
        res = await http(requestUrl, { timeoutMs });
      } catch (e) {
        return Object.assign(base, {
          ok: false,
          requestUrl: safeUrl,
          reason: e && e.code === 'UPSTREAM_MAP_FAILED' ? 'UPSTREAM_FAILED' : 'UNKNOWN',
          message: (e && e.message) || String(e),
          details: (e && e.details) || null,
          timingMs: Date.now() - started,
          photos: [],
          emptyReason: 'UPSTREAM_FAILED',
        });
      }

      const body = res.json || {};
      const status = body.status;
      const pois = Array.isArray(body.pois) ? body.pois : [];
      const ok = String(status) === '1';

      const picked = pickBestByName(pois, name);
      const rawPhotos = picked ? extractPhotos(picked.poi) : [];
      const poiLocation = picked ? parseLocation(picked.poi.location) : null;

      const trust = judgeTrust({
        targetLocation,
        poiLocation,
        expectedName: name,
        poiName: picked ? picked.poi.name : null,
      });

      /**
       * 距离守卫的结果挂到**每一张**照片上，而不是只放在顶层。
       * 客户端按 marker 逐张取用时不会漏掉这个标注 —— 标注漏掉等于没有标注。
       */
      const photos = rawPhotos.map((ph) =>
        Object.assign({}, ph, {
          provider: 'amap',
          poisId: picked ? picked.poi.id || null : null,
          poiName: picked ? picked.poi.name : null,
          trusted: trust.trusted,
          trustBasis: trust.basis,
          distanceMeters: trust.distanceMeters,
        })
      );
      return Object.assign(base, {
        ok,
        requestUrl: safeUrl,
        reason: ok ? null : 'UPSTREAM_STATUS_' + String(status),
        status,
        message: body.info || null,
        /**
         * Key 校验类错误要**带上"曾经去掉过空白"这条信息**。
         * 否则"Key 不正确"会让人去重新申请一个 Key，而实际只是多了个空格。
         *
         * 注意顺序：这里必须**先判断**这个特殊情况再回落到通用提示。
         * 写成 `statusHint(status) || 特殊情况` 是错的 —— 通用提示对 10001
         * 本来就有值，于是特殊情况永远轮不到（2026-10-14 第一版就是这么写的）。
         */
        hint: ok
          ? null
          : String(status) === '10001' && normalized.trimmed
            ? 'AMAP_KEY 前后有多余空白（常见于从控制台表格复制），已自动去除；若仍报此错，请核对 Key 是否为「Web服务」类型'
            : statusHint(status),
        httpStatus: res.httpStatus,
        timingMs: Date.now() - started,
        poiCount: pois.length,
        /** 命中哪个 POI、以及为什么信它 / 不信它 —— 答辩要能说清照片属于哪个点 */
        matchedPoi: picked
          ? {
              id: picked.poi.id || null,
              name: picked.poi.name || null,
              address: picked.poi.address || null,
              location: poiLocation,
            }
          : null,
        matchBasis: picked ? picked.basis : null,
        trust,
        photos,
        parsedVia: { list: 'pois[]', photos: picked ? photosFieldVia(picked.poi) : null },
        emptyReason: explainEmpty({ ok, reason: null, poiCount: pois.length, photos }),
      });
    },
  };
}

/**
 * 从候选里选出最像的那个。
 *
 * 排序依据都可解释：
 *   ① 名字**完全相等** —— 就是它；
 *   ② 名字互相包含（宽松比对）—— 大概率是它，取上游顺序里第一个；
 *   ③ 都不匹配 —— 仍然取第一个，但 `judgeTrust` 会按名字不符判为不可信。
 *
 * ⚠️ 刻意**不**因为"名字不符"就返回 null：那样会把"上游返回了什么"
 * 这个信息丢掉，而界面与排查都需要看到它。
 */
function pickBestByName(pois, expectedName) {
  if (!pois.length) return null;
  const norm = (s) => String(s || '').trim();

  const exact = pois.find((p) => norm(p.name) === norm(expectedName));
  if (exact) return { poi: exact, basis: 'exact-name' };

  const loose = pois.find((p) => nameMatches(expectedName, p.name));
  if (loose) return { poi: loose, basis: 'loose-name' };

  return { poi: pois[0], basis: 'first-result' };
}

module.exports = {
  createAmapPhotoProvider,
  statusHint,
  pickBestByName,
  normalizeKey,
  DEFAULT_REGION,
  CANDIDATE_WINDOW,
};
