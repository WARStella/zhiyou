'use strict';

/**
 * 微信一次性订阅消息 —— **模板与字段映射的唯一事实来源**。
 *
 * ── 为什么这些 ID 写成常量，而不是环境变量 ──────────────────
 *
 * 模板 ID **不是密钥**：它出现在小程序后台、也会出现在客户端
 * `wx.requestSubscribeMessage` 的调用参数里，本来就是公开标识。
 * 而字段编号一旦写错，报出来的是微信那一侧的
 * `47003 argument invalid`，排查要从"哪个字段"猜起。
 *
 * 所以把三个模板的 ID 与**实际字段编号**钉在这里，并让映射表可被测试断言。
 * 字段编号来自用户 2026-10-17 提供的小程序后台截图，**不是按序号猜的**：
 *
 *   · 集合通知：活动名称→thing1、集合地点→thing2、集合时间→time3、备注→thing5
 *   · 状态变更：活动名称→thing1、温馨提示→thing2、变更原因→thing3、变更时间→time4
 *   · 未读提醒：消息内容→thing2、发送时间→time3、发送人昵称→thing4
 *
 * 三套编号**互不相同**（未读提醒没有 1 号字段，集合备注是 5 号不是 4 号）。
 * 曾经按"从 1 开始顺排"的直觉传过一次，那正是 47003 的来源。
 *
 * ── 本文件刻意不做的事 ────────────────────────────────────
 *
 * 不发请求、不读数据库、不读环境变量。纯映射与裁剪，因此可以完整单测。
 * 真正的发送在 `provider.js`（云调用）与 `fake.js`（测试）。
 */

/**
 * 三类通知。
 *
 * `purpose` 是**业务用途**，不是模板名：它决定"什么事件才允许用这个模板"。
 * 交接文档明确写过：状态变更模板不能被拿来当"任意行程修改通知"，
 * 集合通知也不能用来发普通聊天。用途收窄在这里，触发侧就无法越界。
 */
const NOTICE_KINDS = {
  /** 新建/约定集合时通知队员去哪里、几点 */
  MEET_CREATED: 'meet_created',
  /** 集合状态真的变化（确认、取消）时通知 */
  MEET_STATUS_CHANGED: 'meet_status_changed',
  /** 队伍里有新消息、且本人尚未查看时提醒回流 */
  CREW_MESSAGE: 'crew_message',
};

const TEMPLATES = {
  [NOTICE_KINDS.MEET_CREATED]: {
    /** 活动集合通知（模板编号 67212） */
    templateId: 'SHBt_IV0Btag5vKeaI30eBCL6e3bMqlfqvXIBfDtUxI',
    label: '活动集合通知',
    /** 业务字段 → 微信数据键。顺序即渲染顺序，别随意 reorder。 */
    fields: { activityName: 'thing1', meetingPlace: 'thing2', meetingTime: 'time3', remark: 'thing5' },
    /** 打开通知后回到哪里（小程序的页面路径，不带查询串） */
    page: 'pages/map/index',
  },
  [NOTICE_KINDS.MEET_STATUS_CHANGED]: {
    /** 活动状态变更通知（模板编号 77263） */
    templateId: 'CwcjXpUkdcn88NQo3tGIns6OJzdr7omkhMvPk8sPl1A',
    label: '活动状态变更通知',
    fields: { activityName: 'thing1', tip: 'thing2', reason: 'thing3', changedAt: 'time4' },
    page: 'pages/map/index',
  },
  [NOTICE_KINDS.CREW_MESSAGE]: {
    /** 消息未读提醒（模板编号 1185） */
    templateId: 'Xmvcm79SH5MwSw-XWryUToYot_sR0__eshdXAtBOT_8',
    label: '消息未读提醒',
    fields: { content: 'thing2', sentAt: 'time3', senderNickname: 'thing4' },
    page: 'pages/map/index',
  },
};

/**
 * 微信「订阅消息」的字段类型由模板决定，`thing` 类有长度上限。
 *
 * ⚠️ 这些上限**以微信当前规范为准**，本文件按常见口径收紧处理：
 * 超长一律截断并加省略号，而不是原样发出去让微信报 47003。
 * 若后台模板定义的实际上是 `phrase`（更短）或 `character_string`，
 * 需要调整 `MAX_TEXT`；截断策略本身是安全的（不会因为多字而失败）。
 */
const MAX_TEXT = 20;

/**
 * `time` 类字段要求 `YYYY-MM-DD HH:mm` 形式（北京时间，不含时区后缀）。
 *
 * 为什么不让调用方传字符串：一旦有人传了 `toISOString()`，
 * 微信看到的是 `2026-10-17T10:30:00.000Z`，格式校验失败。
 * 统一在这里转，调用方只给 Date 或毫秒数。
 */
function formatTime(value) {
  /**
   * 三种输入都接：`Date`（数据库里读出来就是它）、毫秒数、ISO 字符串。
   * 字符串也要接，因为集合时间从接口传进来时是 ISO ——
   * 只认 Date 的话，调用方会拿到一个空时间，而微信对空 `timeN` 直接报错，
   * 表现为"这个字段莫名其妙发不出去"。
   */
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && value.trim()) ms = Date.parse(value);
  else ms = NaN;
  if (!Number.isFinite(ms)) return '';
  // 云函数运行环境是 UTC，而用户看的是北京时间：显式 +8 小时，不依赖宿主时区。
  const shifted = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** 微信对 `thing` 类字段不接受换行，且超长会整条发送失败。 */
function clampText(value) {
  const raw = String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(raw);
  if (chars.length <= MAX_TEXT) return raw;
  return chars.slice(0, MAX_TEXT - 1).join('') + '…';
}

/**
 * 把业务数据组装成微信要求的结构：
 *
 *     { thing1: { value: '中央大街' }, time3: { value: '2026-10-17 18:30' } }
 *
 * 调用方只给业务字段名（`activityName` 等），**不给微信数据键**——
 * 这样字段编号只存在于本文件一处，业务代码永远不需要知道 `thing5` 这种东西。
 *
 * 缺字段时**不静默补空串**：微信对空值同样报错，而且"发了条空通知"
 * 比"没发"更难排查。所以缺字段直接返回缺失清单，由调用方决定如何处理。
 */
function buildData(kind, values) {
  const template = TEMPLATES[kind];
  if (!template) return { ok: false, reason: 'UNKNOWN_KIND', missing: [], data: null };
  const source = values || {};
  const missing = Object.keys(template.fields).filter((field) => {
    const value = source[field];
    return value === undefined || value === null || String(value).trim() === '';
  });
  if (missing.length) return { ok: false, reason: 'MISSING_FIELDS', missing, data: null };

  const data = {};
  for (const [field, wxKey] of Object.entries(template.fields)) {
    const value = source[field];
    data[wxKey] = {
      // 时间类字段是 `timeN`，其余是文本类。
      value: /^time\d+$/.test(wxKey) ? formatTime(value) : clampText(value),
    };
  }
  return { ok: true, reason: null, missing: [], data };
}

/**
 * 通知点击后的落地页。
 *
 * 只带**非敏感的定位线索**（队伍 ID、消息序号），绝不把消息正文、昵称
 * 或其他内容塞进 query —— 通知详情在微信里本来就能看到，
 * 而落地页必须重新经过 `requireCrewMember` 鉴权才能取到真实内容。
 *
 * ⚠️ 队伍页是 tab 页，**不能用带参 URL 直接 switchTab**（见交接文档第 3 节第 7 条）。
 * 所以这里返回带参路径，由客户端把它写进 storage 锚点，再切到 tab 页，
 * 页面 `onShow` 读锚点自行恢复上下文。
 */
function landingPage(kind, params) {
  const template = TEMPLATES[kind];
  const page = template ? template.page : 'pages/map/index';
  const query = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${page}?${query}` : page;
}

/** 供 `config-health` 与文档使用：当前接入了哪几类、用哪个模板。 */
function describeTemplates() {
  return Object.entries(TEMPLATES).map(([kind, t]) => ({
    kind, label: t.label, templateId: t.templateId,
    fields: Object.assign({}, t.fields),
  }));
}

module.exports = { NOTICE_KINDS, TEMPLATES, MAX_TEXT, formatTime, clampText, buildData,
  landingPage, describeTemplates };
