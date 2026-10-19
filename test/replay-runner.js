'use strict';

/**
 * 团队流程回放执行器 —— 把 `data/team-replay/cases.v1.json` 里的**设计稿**
 * 真正跑起来，并留下可复核的执行记录。
 *
 * ══════════ 为什么需要这一层 ══════════
 *
 * 案例集是**规格**，不是结果：`executionRecord` / `recordedAt` 全是 `null`。
 * 计划书 §11.3 的原话是「**每条可复现、跑过才算完成**」——
 * 没有跑过就没有证据，而"看起来设计得很细"不等于跑得通。
 *
 * 本文件做三件事：
 *   ① 按 `initialState` **原样注入夹具**（不走任何允许的 action 去伪造状态，
 *      尤其不伪造 `version` —— 那是 `replay-013` 的 invariants 明确禁止的）；
 *   ② 按 `steps[]` 顺序调用**真实 action**（与线上同一条 `invoke` 路径，
 *      只有仓储实现不同）；
 *   ③ 把案例里那些中文散文（`expectedState` / `invariants`）**翻译成可判定的断言**。
 *      这一步是本执行器真正的价值：散文能被人读成任意结论，断言不能。
 *
 * ══════════ 三条贯穿全文的纪律 ══════════
 *
 * 1. **`expectedVersion` 在信封层，不在 `payload` 里。**
 *    这是本项目踩过的真实缺陷：前端把它塞进 `payload` → 信封层读不到
 *    → 回落成"当前版本" → **版本校验在生产路径上从未生效**。
 *    所以本执行器**只**读步骤自己的 `expectedVersion` 字段，
 *    并且有一条断言专门检查 `payload` 里没有出现这个键。
 *
 * 2. **不许为了让案例通过而放宽断言。**
 *    判定不了的（只能人工看的）一律标 `checkedBy: 'manual'`、`passed: null`，
 *    **不计入通过**。案例与实现冲突时先判断是哪一边错：
 *      · 实现有缺陷 → 整条记 `blocked`，写清 finding（现象/期望/位置/原始响应），
 *        **不改实现**（那是另一件事），也不放宽断言；
 *      · 案例写错（与文档约定矛盾）→ 记 `caseDefect` 并说明依据，**不改 cases.v1.json**。
 *    两种裁决都写在本文件里（见 `CASE_VERDICTS` / `CASE_DEFECTS`），不藏在某次会话里。
 *
 * 3. **夹具注入是回放的固有边界，必须如实标注。**
 *    初始状态是"历史已经发生"，由夹具直接写库；只有 `steps[]` 才是真实调用。
 *    因此每条记录都带 `fixtureInjected: true` 与 `fixtureNotes`，
 *    说明初始状态**不是**由这些 action 产生的。
 *
 * ══════════ 与 README 的两处执行约定 ══════════
 *
 * · `data/team-replay/README.md` §五.1 建议用 `repo.__seed` 灌夹具。
 *   本执行器改用 `repo.insert`：同样原样保留案例给出的 `_id`，
 *   但**多走一遍生产同款的唯一索引校验**（如 `crew_members(crewId,userId)`），
 *   夹具里出现重复成员会当场报错而不是被静默接受。
 * · README §五.1 也写明 `initialState.locations[].stale` 是"夹具对时效的预期标注，
 *   服务端读取时按 `reportedAt` 现算"，**不是存储字段** —— 所以注入时不落这个键。
 */

const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const { makeWorld } = require('./helpers');
const C = require('../cloudfunctions/api/lib/repo/collections');
const { POLICY_VERSION: LOCATION_POLICY_VERSION } = require('../cloudfunctions/api/lib/location-consent');
const { createMapProvider } = require('../cloudfunctions/api/lib/map');
const { createReplayTransport, kindOfUrl } = require('../cloudfunctions/api/lib/map/replay');
const { createTencentProvider } = require('../cloudfunctions/api/lib/map/tencent');
const { HttpError, redact } = require('../cloudfunctions/api/lib/http');

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const DATASET_PATH = join(__dirname, '..', 'data', 'team-replay', 'cases.v1.json');
const RECORDS_DIR = join(__dirname, '..', 'data', 'team-replay', 'records');

/** 本批要跑的 6 条：每类各一条 + 第 5 类补一条（`replay-017` 在数据里 `core:false`）。 */
const REPLAY_CASE_IDS = [
  'replay-001',
  'replay-005',
  'replay-009',
  'replay-013',
  'replay-017',
  'replay-021',
];

/**
 * 证据分级口径 —— **三种级别必须分别报告**。
 * 把 synthetic 的通过数与 indoor_device 的通过数加在一起说"都过了"，
 * 是把"规则在构造条件下成立"与"两台设备点得通"混为一谈。
 */
const EVIDENCE_LEVEL_NOTE =
  '室内/合成/回放三种级别必须分别报告；室内点击只能证明状态流转，不能证明真实步行时间与集合效率';

/** 案例里的 `actor` → 三个不同客户端之一（`makeWorld` 的 A/B/C 位置）。 */
const ACTOR_CLIENT = { 'owner-a': 'A', 'member-b': 'B', 'member-c': 'C' };

// ─────────────────────────────────────────────────────────────
// 通用工具
// ─────────────────────────────────────────────────────────────

const pass = (evidence) => ({ passed: true, evidence });
const fail = (evidence) => ({ passed: false, evidence });

const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** 排序键的规范化序列化 —— 用来判"文档有没有被改写"，不受键顺序影响。 */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
    .join(',')}}`;
}

const trim = (s, n) => {
  const str = String(s);
  return str.length > (n || 260) ? `${str.slice(0, n || 260)}…` : str;
};

/**
 * 取一个点分路径的值。支持 `a.b.c`、`arr[].field`（映射整个数组）。
 * ⚠️ 一旦用了 `[]`，结果**一定是数组**（哪怕只映射出一项）——
 * 否则"一项"与"一项的数组"会看起来一样，断言会悄悄失效。
 */
function pathGet(obj, path) {
  const parts = String(path).split('.');
  let cur = [obj];
  let mapped = false;
  for (const raw of parts) {
    const isMap = raw.endsWith('[]');
    const key = isMap ? raw.slice(0, -2) : raw;
    if (isMap) mapped = true;
    const next = [];
    for (const item of cur) {
      if (item == null) continue;
      const v = item[key];
      if (isMap) {
        if (Array.isArray(v)) next.push(...v);
      } else {
        next.push(v);
      }
    }
    cur = next;
  }
  return mapped ? cur : cur[0];
}

/** 声明式的取值清单 —— 用来生成记录里紧凑的 `observed`。 */
function pickPaths(target, paths) {
  const out = {};
  for (const p of paths || []) out[p] = pathGet(target, p);
  return out;
}

/** 逐路径比对；返回 null 表示全部一致，否则返回第一处不一致的说明。 */
function comparePaths(data, expected) {
  for (const [p, want] of Object.entries(expected || {})) {
    const got = pathGet(data, p);
    if (canon(got) !== canon(want)) {
      return `「${p}」期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`;
    }
  }
  return null;
}

/** 期望构造器 —— 让"每一步应该看到什么"写起来短、读起来清楚。 */
const E = {
  /** 成功，且这些路径的值必须精确等于给定值 */
  ok(expected, extra) {
    return (res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const mismatch = comparePaths(res.data, expected);
      if (mismatch) return fail(mismatch);
      const shown = Object.entries(expected || {})
        .map(([p]) => `${p}=${JSON.stringify(pathGet(res.data, p))}`)
        .join(' ');
      return pass(`${shown}${extra ? `；${extra}` : ''}`);
    };
  },
  /** 明确被拒（负向探针）：错误码必须精确等于给定值 */
  fail(code) {
    return (res) => {
      if (res.ok) {
        return fail(`期望被拒（${code}），实际成功：${trim(JSON.stringify(res.data))}`);
      }
      if (res.error.code !== code) {
        return fail(`期望错误码 ${code}，实际 ${res.error.code}：${res.error.message}`);
      }
      return pass(`被拒：${res.error.code} — ${res.error.message}`);
    };
  },
  /** 其余情况写函数，避免 DSL 变成另一套要学的语言 */
  fn(f) {
    return f;
  },
};

// ─────────────────────────────────────────────────────────────
// 数据集与夹具
// ─────────────────────────────────────────────────────────────

let datasetCache = null;

function loadDataset() {
  if (!datasetCache) {
    const raw = readFileSync(DATASET_PATH);
    datasetCache = { raw, json: JSON.parse(raw.toString('utf8')) };
  }
  return datasetCache;
}

/** `cases.v1.json` 的**内容哈希** —— 数据一改，"上次是在哪批数据上跑的"就说不清了。 */
function sourceSha256() {
  return createHash('sha256').update(loadDataset().raw).digest('hex');
}

const definedOnly = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
};

/**
 * 把 `initialState` 原样写进内存仓储。
 *
 * ⚠️ 这里是"历史已经发生"的部分：**不经过任何 action**。
 * 计划书与案例都要求初始状态由夹具注入（`replay-013` 的 invariants 甚至
 * 明确写了"不得用允许的 action 伪造该版本"）——因为白名单里根本没有
 * 能产生"集合内容已升版、参与者确认仍是旧版本"的 action。
 */
async function injectFixture(w, caseDef) {
  const s = caseDef.initialState;
  const crewId = s.crew.crewId;
  const notes = [];

  const crewDoc = Object.assign(
    { _id: crewId },
    definedOnly({
      name: s.crew.name,
      ownerUserId: s.crew.ownerUserId,
      inviteCode: s.crew.inviteCode,
      shareLocationDefault: s.crew.shareLocationDefault,
      status: s.crew.status,
      memberCount: s.crew.memberCount,
    })
  );
  await w.repo.insert(C.CREWS, crewDoc);

  for (const m of s.crew.members) {
    const consentId = m.locationSharing === true ? `fixture-consent-${crewId}-${m.userId}` : null;
    if (consentId) await w.repo.insert(C.PRIVACY_CONSENTS, {
      _id: consentId, userId: m.userId, crewId, scope: 'location', purpose: 'crew_location_sharing',
      policyVersion: LOCATION_POLICY_VERSION, granted: true, source: 'replay_fixture', grantedAt: s.clock || null,
    });
    await w.repo.insert(
      C.CREW_MEMBERS,
      definedOnly({
        crewId,
        userId: m.userId,
        role: m.role,
        status: m.status,
        locationSharing: m.locationSharing,
        locationConsentId: consentId,
        locationConsentPolicyVersion: consentId ? LOCATION_POLICY_VERSION : null,
        locationConsentGrantedAt: consentId ? s.clock : null,
        joinedAt: m.joinedAt || null,
        leftAt: m.leftAt === undefined ? null : m.leftAt,
        lastLocationAt: m.lastLocationAt === undefined ? null : m.lastLocationAt,
      })
    );
  }
  notes.push(
    `crew_members：${s.crew.members.length} 条，按案例给的 role/status/locationSharing 注入（joinedAt 案例未给则写 null）`
  );
  notes.push('明确共享的历史夹具补本版同意记录，source=replay_fixture，仅为内存测试前置条件，不是线上用户真实同意。重新加入仍须主动开启。');

  if (s.trip) {
    await w.repo.insert(C.TRIPS, Object.assign({ _id: s.trip.tripId }, s.trip));
    notes.push(
      `trips：原样注入，**version=${s.trip.version} 直接写库、不经任何 action**（案例未给的字段如 params/title/generatedBy 一律不补）`
    );
  }

  if (s.meetTask) {
    await w.repo.insert(C.MEET_TASKS, Object.assign({ _id: s.meetTask.meetTaskId }, s.meetTask));
    notes.push(
      `meet_tasks：原样注入，version=${s.meetTask.version}、participants 的 confirmedVersion 与案例一致` +
        (s.meetTask.revision === undefined ? '（案例未给 revision → 不写该字段，与"字段缺失"这一事实保持一致）' : '')
    );
  }

  if (s.locations && s.locations.length) {
    for (const loc of s.locations) {
      await w.repo.insert(
        C.LOCATIONS,
        definedOnly({
          userId: loc.userId,
          /**
           * ⚠️ 夹具补全：案例的 `locations[]` 只写了 userId/point/source/reportedAt，
           * 而读取路径（`loc.list`、`meet.recommend`）按 `{userId, crewId}` 查。
           * 不补 `crewId` 的话列表永远查不到任何位置 —— 那样"退出者不得再出现"
           * 这类断言会**因为列表本来就是空的而恒真**（夹具形状决定测试在测什么）。
           * 补的是**外键**，不是任何断言语义。
           */
          crewId,
          point: loc.point,
          source: loc.source,
          reportedAt: loc.reportedAt,
        })
      );
    }
    notes.push(
      `locations：${s.locations.length} 条；补了 crewId=${crewId}（案例未给，读取路径按 {userId,crewId} 查），` +
        '未落 `stale` 键（README §五.1：它是服务端按 reportedAt 现算的标注，不是存储字段）'
    );
  }

  if (s.places && s.places.length) {
    for (const p of s.places) await w.repo.insert(C.PLACES, p);
    notes.push(`places：${s.places.length} 条，按案例给的 _id/name/location 注入（本世界不铺默认地点夹具）`);
  }

  notes.push('世界不铺默认地点夹具（seedPlaces: []）——避免"夹具形状决定测试在测什么"');

  return { notes, crewId };
}

/** 注入后的初始快照，供"有没有被改写"一类断言逐字段比对。 */
async function snapshotInitial(w, ids) {
  const snap = {
    crew: await w.repo.get(C.CREWS, ids.crewId),
    members: await w.repo.find(C.CREW_MEMBERS, { crewId: ids.crewId }),
    locations: await w.repo.find(C.LOCATIONS, { crewId: ids.crewId }),
  };
  if (ids.tripId) snap.trip = await w.repo.get(C.TRIPS, ids.tripId);
  if (ids.meetTaskId) snap.meetTask = await w.repo.get(C.MEET_TASKS, ids.meetTaskId);
  return snap;
}

// ─────────────────────────────────────────────────────────────
// 占位符：服务端生成的 id 一律从前序响应里取，不得自行编造
// ─────────────────────────────────────────────────────────────

class ReplayError extends Error {}

/**
 * `<stepN.path>` / `<stepN.path 中 feasible=true 的 field>` / `<probeN.path>`。
 *
 * README §五.2 的原话是"执行器必须在运行时替换，**不得自行编造**"，
 * 所以取不到时一律**明确失败并说明**，不跳过、不留空。
 */
function resolvePlaceholder(expr, state) {
  const text = String(expr).trim();
  const head = /^(step|probe)(\d+)\.(.+)$/.exec(text);
  if (!head) throw new ReplayError(`无法解析的占位符：<${expr}>`);

  const kind = head[1];
  const index = Number(head[2]);
  const rest = head[3];

  /**
   * ⚠️ 两种来源的形状不同：`state.responses` 里存的就是响应本身，
   * 而 `state.probeResults` 里存的是探针记录（响应在 `.response` 上）。
   * 第一版把两者当成同一种形状，于是**只要步骤成功也报"该步没有成功"** ——
   * 这类"取不到值"的报错必须能一眼看出是执行器自己的问题。
   */
  const entry = kind === 'step' ? state.responses[String(index)] : state.probeResults[`P${index}`];
  const label = kind === 'step' ? `第 ${index} 步` : `第 ${index} 个探针`;
  const response = kind === 'step' ? entry : entry && entry.response;

  if (!entry) throw new ReplayError(`占位符 <${expr}> 依赖${label}，但它还没有执行`);
  if (!response || !response.ok) {
    const code = response && response.error ? response.error.code : '(无响应)';
    throw new ReplayError(`占位符 <${expr}> 依赖的${label}没有成功（${code}），无法从中取值`);
  }
  const data = response.data || {};

  const selector = /^(.+?)\s*中\s*([A-Za-z0-9_]+)\s*=\s*(\S+)\s*的\s*([A-Za-z0-9_]+)$/.exec(rest);
  if (selector) {
    const list = pathGet(data, selector[1]);
    if (!Array.isArray(list)) {
      throw new ReplayError(`占位符 <${expr}> 的「${selector[1]}」不是数组（实际 ${JSON.stringify(trim(canon(list), 80))}）`);
    }
    const want = selector[3] === 'true' ? true : selector[3] === 'false' ? false : selector[3];
    const hit = list.find((x) => x && x[selector[2]] === want);
    if (!hit) {
      throw new ReplayError(
        `占位符 <${expr}> 在「${selector[1]}」里找不到 ${selector[2]}=${want} 的项` +
          `（实际取值：${JSON.stringify(list.map((x) => (x ? x[selector[2]] : null)))}）`
      );
    }
    return hit[selector[4]];
  }

  const value = pathGet(data, rest);
  if (value === undefined) throw new ReplayError(`占位符 <${expr}> 在前序响应里取不到值（路径 ${rest} 不存在）`);
  if (value === null) throw new ReplayError(`占位符 <${expr}> 的值为 null —— 不能拿它当参数继续`);
  return value;
}

/** 递归替换 payload 里的 `<...>`；整体就是一个占位符时返回原值（可能是数字/布尔）。 */
function resolvePayload(value, state) {
  if (typeof value === 'string') {
    const whole = /^<([^<>]+)>$/.exec(value);
    if (whole) return resolvePlaceholder(whole[1], state);
    return value.replace(/<([^<>]+)>/g, (_, expr) => String(resolvePlaceholder(expr, state)));
  }
  if (Array.isArray(value)) return value.map((v) => resolvePayload(v, state));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePayload(v, state);
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────
// 已裁决的缺陷（默认空）
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 这两张表是**裁决结果**，不是执行器能自己算出来的东西：
//    "实现错"还是"案例错"必须由人对着实现与文档判定，
//    判定结果写在这里、连同证据，才算留下了可复核的痕迹。
//    执行器只负责：按裁决改状态、把 finding 原样带进记录与测试。

/** 实现有缺陷 → 该案例记 blocked，测试变红，**不放宽断言**。 */
// 2026-10-15 修复后，replay-021 的原有机器断言全部通过。
// 保留旧缺陷证据供追溯；已解决的裁决不再覆盖真实执行结果。
const RESOLVED_CASE_VERDICTS = {
  'replay-021': {
    status: 'blocked',
    finding: {
      kind: 'implementationDefect',
      caseAssertion:
        'replay-021 invariant#2：「规划中取不到真实路线的路段必须计入 walkTimes.failures，其 travelSource 不得为 upstream / survey」',
      symptom:
        '带 startPoint 的 trip.plan 在"起点段"取不到真实路线时，这一段回落成了直线估算（travelSource=estimated），' +
        '但**没有**计入 walkTimes.failures：同一条响应里 `bySource.estimated = 2`（两段都是估算）、' +
        '`upstreamFailed = 1`、`failures` 只有 1 条（防洪纪念塔→圣索菲亚教堂），' +
        '`note` 也写成「有 1 段没能从地图服务取到路线」——**"估算段数"与"失败段数"自相矛盾**。' +
        '起点段（我的位置→防洪纪念塔）的失败只出现在 legOptions[0].unavailable 与 startLeg.candidateReason 里，' +
        '没有进入 walkTimes 的失败账。',
      expected:
        '按案例 invariant#2 的字面要求，凡是"取不到真实路线"的行程段（含起点段）都必须计入 walkTimes.failures；' +
        '按项目自己的既有约定（test/api.test.js:819-820「失败段数要如实报告」同时断言 upstreamFailed === 1 与 ' +
        'bySource.estimated === 1，即**失败段数 == 估算段数**），这条响应应当是 failures 2 条 / upstreamFailed 2；' +
        '至少不该出现 bySource.estimated(2) > upstreamFailed(1) 这种"看起来有一段是真实路线"的读数。',
      location: [
        'cloudfunctions/api/actions/trip.js:80 —— `fillMissingWalkTimes` 的循环 `for (let i = 1; i < placeIds.length; i++)`：' +
          '只遍历"上一站→下一站"，起点段（`startPoint` → 第一站）不在其中，它的失败永远进不了 `failures`。',
        'cloudfunctions/api/actions/trip.js:991 / :1016 / :1100 —— 起点段的失败记账只在"`travelResolve.legTimes[第一站]` ' +
          '**没有**数值"这条 `else if` 分支里；而本案例里它**有**估算值（来自 lib/leg-times.js 的兜底），于是这段分支被绕过，' +
          '`walkFill.failed++` 一次都没执行。',
        'lib/leg-times.js:326-339 —— 兜底估算只把 `provider: "estimate" / source: "estimated"` 写进候选与 `legOptions`，' +
          '不上报给 `walkTimes.failures`。',
        'cloudfunctions/api/actions/trip.js:1159 / :1176-1177 —— `upstreamFailed: walkFill.failed` 与 `note` 里的段数都取自这个漏计的计数。',
      ],
      rawResponse: {
        walkTimes: {
          bySource: { estimated: 2 },
          fetchedFromMap: 0,
          fromCache: 0,
          upstreamFailed: 1,
          failures: [
            {
              from: '防洪纪念塔',
              to: '圣索菲亚教堂',
              reason: 'UPSTREAM_FAILED',
              message: '没有对应的录音：kind=direction-walking keyword=(无) from=45.781,126.6185 to=45.7703,126.6206',
            },
          ],
          mapApiCalls: 1,
          note: '有 1 段没能从地图服务取到路线，已回落为**直线估算**（时间可能明显偏小）',
        },
        nodes: [
          { placeId: 'place-b', placeName: '防洪纪念塔', travelSource: 'estimated', travelFromStart: true, travelFromPrevMin: 11 },
          { placeId: 'place-c', placeName: '圣索菲亚教堂', travelSource: 'estimated', travelFromPrevMin: 21 },
        ],
        startLeg: {
          source: 'estimated',
          provider: 'estimate',
          candidateReason: '取不到真实耗时，按直线距离估算（短距离下偏差可能很大）',
          minutes: 11,
        },
        'legOptions[0].unavailable': [
          { mode: 'walking', reason: '没有对应的录音：kind=unknown … from=45.7756,126.6175 to=45.781,126.6185' },
          { mode: 'bicycling', reason: '没有对应的录音：kind=unknown …' },
          { mode: 'transit', reason: '没有对应的录音：kind=transit' },
        ],
      },
      whyBlocked:
        '案例的断言与实现冲突，按项目纪律先判断是哪一边错：这里**实现**与它自己的另一处约定（test/api.test.js:819-820）' +
        '以及案例 invariant#2 的字面要求都不一致，属于实现侧的漏计（起点段走了与其余段不同的记账路径）。' +
        '不改实现（那是另一件事），也不放宽断言 —— 因此这一条停在 blocked。',
      nextStep:
        '修实现时注意：起点段的失败记账要与其余段走同一条路径（例如在 leg-times 的兜底分支里回传失败原因，' +
        '或让 `plan` 把 `travelResolve.calls`/失败一并并入 `walkFill`）。修好之后删掉这条裁决，' +
        '本执行器会自动把该案例恢复为 passed/failed。',
    },
  },
};

const CASE_VERDICTS = {};

/** 案例与文档约定矛盾 → 记 caseDefect，**不改 cases.v1.json**，只报告。 */
const CASE_DEFECTS = {
  'replay-017': [{
    where: '重新加入后恢复队伍默认共享开关',
    observed: '重新加入后共享关闭，旧同意不恢复',
    basis: '2026-10-15 用户授权修复隐私同意留痕；建队、入队均不代表本人同意共享位置。',
    impact: '保留原始 cases.v1.json，执行器明确改用当前隐私规则：重新加入复用身份记录，但必须重新主动开启共享。其余成员、鉴权和集合断言保留。',
  }],
  'replay-001': [
    {
      where: 'expectedState.response.step1.status = "confirmed"',
      observed: '"active"（第一位成员标记到达后，集合任务由 confirmed 进入 active）',
      basis:
        'docs/项目计划书.md#data-model §2.10 的状态机是 `proposed → confirmed → active → arrived_all → departed → completed`，' +
        '计划书 §7.2 的流程亦为「… 生效 → 前往 → 到达 → 到齐 → 出发 …」。' +
        '既然"已经有人在标记到达"，状态就已经不在 confirmed 了；' +
        '实现（domain/meet.js `applyArrive`：未全员到齐且原状态为 confirmed 时置 active）与文档一致。',
      impact:
        '只是案例 expectedState 里的一处取值写错，不影响该案例的核心主张（三时间分离、到齐不改路线）：' +
        '案例自己的 step1 note 只要求 arrivedCount=1 且 allArrivedAt 仍为 null，两处实现都满足。',
    },
  ],
};

// ─────────────────────────────────────────────────────────────
// 六个案例的断言翻译表
// ─────────────────────────────────────────────────────────────
//
// 每条 invariants 条目的 `text` 一字不改地抄自案例；`checks` 是它的机器翻译。
// `expectedState` 里的散文同样翻译成断言，单独放在 `expectedStateChecks`。

const CASE_SPECS = {};

// ── replay-001 全员到齐但尚未出发 ───────────────────────────────
CASE_SPECS['replay-001'] = {
  observe: {
    1: ['status', 'arrivedCount', 'participantCount', 'allArrivedAt', 'tripUpdated'],
    2: ['status', 'arrivedCount', 'participantCount', 'allArrivedAt', 'tripUpdated'],
    3: ['status', 'arrivedCount', 'participantCount', 'allArrivedAt', 'tripUpdated', 'message'],
    4: [
      'meetTask.status',
      'meetTask.version',
      'meetTask.plannedMeetAt',
      'meetTask.allArrivedAt',
      'meetTask.departedAt',
      'meetTask.participants[].status',
      'meetTask.participants[].arrivedAt',
    ],
    5: ['trip.version', 'trip.plannedEndAt', 'trip.nodes[].status', 'trip.nodes[].plannedStayMin', 'trip.nodes[].seq'],
  },
  expect: {
    1: E.ok(
      { status: 'active', arrivedCount: 1, allArrivedAt: null, tripUpdated: false },
      '案例 expectedState 写的是 step1.status=confirmed，但文档状态机没有"已有人到达却仍是 confirmed"这一档（见 caseDefects）'
    ),
    2: E.ok({ status: 'active', arrivedCount: 2, allArrivedAt: null, tripUpdated: false }),
    3: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.status !== 'arrived_all') problems.push(`status=${d.status}`);
      if (!d.allArrivedAt) problems.push('allArrivedAt 仍为空（最后一人到达时必须写 ②）');
      if (d.tripUpdated !== false) problems.push(`tripUpdated=${d.tripUpdated}`);
      if (d.arrivedCount !== 3) problems.push(`arrivedCount=${d.arrivedCount}`);
      if (!/暂不调整|等待确认出发|前往下一站/.test(String(d.message || ''))) {
        problems.push(`message 未表达"暂不调整、等待确认出发"：${d.message}`);
      }
      return problems.length
        ? fail(problems.join('；'))
        : pass(`status=arrived_all allArrivedAt=${iso(d.allArrivedAt)} tripUpdated=false arrivedCount=3 message=「${d.message}」`);
    }),
    4: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const t = res.data.meetTask;
      const problems = [];
      if (t.plannedMeetAt !== '2026-10-20T01:00:00.000Z') problems.push(`plannedMeetAt=${t.plannedMeetAt}`);
      if (!t.allArrivedAt) problems.push('allArrivedAt 为空');
      if (t.departedAt !== null) problems.push(`departedAt=${t.departedAt}`);
      return problems.length
        ? fail(problems.join('；'))
        : pass(`plannedMeetAt=${t.plannedMeetAt}（①不变）allArrivedAt=${t.allArrivedAt}（②已写）departedAt=null（③未写）`);
    }),
    5: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const t = res.data.trip;
      const problems = [];
      if (t.version !== 3) problems.push(`version=${t.version}`);
      if (t.plannedEndAt !== '2026-10-20T05:00:00.000Z') problems.push(`plannedEndAt=${iso(t.plannedEndAt)}`);
      const statuses = t.nodes.map((n) => n.status);
      if (statuses.some((s) => s !== 'pending')) problems.push(`nodes[].status=${JSON.stringify(statuses)}`);
      return problems.length
        ? fail(problems.join('；'))
        : pass(`version=3 plannedEndAt=${iso(t.plannedEndAt)} nodes 全为 pending（${t.nodes.length} 个）`);
    }),
  },
  probes: [],
  invariants: [
    {
      text: 'allArrivedAt 非空时 departedAt 必须仍为 null（② 到齐 ≠ ③ 出发）',
      checks: [
        {
          at: 4,
          desc: 'meet.get 读回三时间 + 存储层复核',
          run: async (ctx) => {
            const resp = ctx.data(4).meetTask;
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const problems = [];
            if (!resp.allArrivedAt) problems.push('响应 allArrivedAt 为空');
            if (resp.departedAt !== null) problems.push(`响应 departedAt=${resp.departedAt}`);
            if (!doc.allArrivedAt) problems.push('存储 allArrivedAt 为空');
            if (doc.departedAt !== null) problems.push(`存储 departedAt=${iso(doc.departedAt)}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass(`存储与响应一致：allArrivedAt=${iso(doc.allArrivedAt)}，departedAt=null`);
          },
        },
      ],
    },
    {
      text: 'meet.arrive 不得改变 trip.version、trip.nodes 或 trip.plannedEndAt，响应 tripUpdated 必须为 false',
      checks: [
        ...[1, 2, 3].map((n) => ({
          at: n,
          desc: `第 ${n} 次 meet.arrive 之后行程逐字段未变`,
          run: async (ctx) => ctx.tripUnchanged(`第 ${n} 次到达之后`),
        })),
        {
          at: 3,
          desc: '三次到达响应的 tripUpdated',
          run: async (ctx) => {
            const flags = [1, 2, 3].map((n) => ctx.data(n).tripUpdated);
            return flags.every((f) => f === false)
              ? pass(`tripUpdated=[${flags.join(', ')}]（三次都是 false）`)
              : fail(`tripUpdated=[${flags.join(', ')}]，必须全为 false`);
          },
        },
      ],
    },
    {
      text: 'plannedMeetAt 全程不变：它只在 meet.create 时写入，不得被到达事件改写',
      checks: [
        {
          at: 3,
          desc: '三次到达之后存储层 plannedMeetAt',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const want = ctx.initial.meetTask.plannedMeetAt;
            if (canon(doc.plannedMeetAt) !== canon(want)) {
              return fail(`plannedMeetAt 被改写：${iso(doc.plannedMeetAt)} ≠ ${iso(want)}`);
            }
            return pass(`plannedMeetAt=${iso(doc.plannedMeetAt)} 与夹具一致（到达事件没有碰它）`);
          },
        },
        {
          at: 3,
          desc: '① 与 ② 是两个不同的时刻，不得互相顶替',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            if (!doc.allArrivedAt) return fail('allArrivedAt 为空，无法比较');
            if (iso(doc.allArrivedAt) === iso(doc.plannedMeetAt)) {
              return fail(`allArrivedAt 与 plannedMeetAt 相同（${iso(doc.allArrivedAt)}）—— 有互相顶替的嫌疑`);
            }
            return pass(`①=${iso(doc.plannedMeetAt)} ≠ ②=${iso(doc.allArrivedAt)}（两者独立记录）`);
          },
        },
      ],
    },
    {
      text: '只有全部未退出参与者都到达时才写 allArrivedAt；arrivedCount 应等于参与人数减去 declined 人数',
      checks: [
        {
          at: 1,
          desc: '第一人到齐前不得写 ②',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            if (doc.allArrivedAt !== null) return fail(`只到了 1 人却写了 allArrivedAt=${iso(doc.allArrivedAt)}`);
            if (ctx.data(1).arrivedCount !== 1) return fail(`arrivedCount=${ctx.data(1).arrivedCount}`);
            return pass('1/3 到达：arrivedCount=1，allArrivedAt 仍为 null');
          },
        },
        {
          at: 2,
          desc: '第二人到齐前不得写 ②',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            if (doc.allArrivedAt !== null) return fail(`只到了 2 人却写了 allArrivedAt=${iso(doc.allArrivedAt)}`);
            if (ctx.data(2).arrivedCount !== 2) return fail(`arrivedCount=${ctx.data(2).arrivedCount}`);
            return pass('2/3 到达：arrivedCount=2，allArrivedAt 仍为 null');
          },
        },
        {
          at: 3,
          desc: '全员到达才写 ②，且 arrivedCount = 参与人数 − declined 人数',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const declined = doc.participants.filter((p) => p.status === 'declined').length;
            const arrived = doc.participants.filter((p) => p.status === 'arrived').length;
            const problems = [];
            if (!doc.allArrivedAt) problems.push('全员到达却没写 allArrivedAt');
            if (arrived !== doc.participants.length - declined) {
              problems.push(`arrived=${arrived} ≠ 参与者 ${doc.participants.length} − declined ${declined}`);
            }
            if (ctx.data(3).arrivedCount !== arrived) {
              problems.push(`响应 arrivedCount=${ctx.data(3).arrivedCount} ≠ 存储 ${arrived}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`3/3 到达（declined=0）：arrivedCount=3，allArrivedAt=${iso(doc.allArrivedAt)}`);
          },
        },
      ],
    },
    {
      text: 'trip.version 在到齐前后都等于 3（无调整时版本不涨）',
      checks: [1, 2, 3, 5].map((n) => ({
        at: n,
        desc: `第 ${n} 步之后 trip.version`,
        run: async (ctx) => {
          const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
          return trip.version === 3
            ? pass(`第 ${n} 步之后 trip.version=${trip.version}`)
            : fail(`第 ${n} 步之后 trip.version=${trip.version}，应为 3`);
        },
      })),
    },
  ],
  expectedStateChecks: [
    {
      at: 4,
      text: 'expectedState.meetTask：status=arrived_all、version=1、plannedMeetAt 不变、allArrivedAt 非空、departedAt=null、三人 status=arrived 且 arrivedAt 非空',
      run: async (ctx) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
        const problems = [];
        if (doc.status !== 'arrived_all') problems.push(`status=${doc.status}`);
        if (doc.version !== 1) problems.push(`version=${doc.version}`);
        if (iso(doc.plannedMeetAt) !== '2026-10-20T01:00:00.000Z') problems.push(`plannedMeetAt=${iso(doc.plannedMeetAt)}`);
        if (!doc.allArrivedAt) problems.push('allArrivedAt 为空');
        if (doc.departedAt !== null) problems.push('departedAt 非 null');
        for (const p of doc.participants) {
          if (p.status !== 'arrived') problems.push(`${p.userId}.status=${p.status}`);
          if (!p.arrivedAt) problems.push(`${p.userId}.arrivedAt 为空`);
        }
        return problems.length
          ? fail(problems.join('；'))
          : pass('arrived_all / version=1 / plannedMeetAt 不变 / allArrivedAt 非空 / departedAt=null / 三人 arrived 且 arrivedAt 非空');
      },
    },
  ],
};

// ── replay-005 集合延误导致后续超时 ──────────────────────────────
CASE_SPECS['replay-005'] = {
  observe: {
    1: [
      'canDepart',
      'checkId',
      'expiresAt',
      'delayMin',
      'tripImpact.conflicts[].code',
      'tripImpact.remainingEndAt',
      'proposal.proposalId',
      'proposal.feasibleCount',
      'proposal.candidates[].candidateId',
      'proposal.candidates[].feasible',
    ],
    2: ['error.code', 'error.message'],
    3: ['trip.version', 'trip.nodes[].plannedStayMin', 'trip.nodes[].status'],
    4: ['applied', 'version', 'candidateId', 'changes[].code', 'plannedEndAt'],
    5: ['canDepart', 'checkId', 'expiresAt', 'delayMin', 'proposal', 'tripImpact.conflicts[].code'],
    6: ['status', 'departedAt', 'delayMin', 'tripImpact.delayMin'],
  },
  expect: {
    1: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.canDepart !== false) problems.push(`canDepart=${d.canDepart}`);
      if (!d.checkId) problems.push('checkId 为空');
      if (!d.expiresAt) problems.push('expiresAt 为空');
      if (!d.proposal) problems.push('未生成变更提案');
      const codes = (d.tripImpact && d.tripImpact.conflicts ? d.tripImpact.conflicts : []).map((c) => c.code);
      if (!codes.includes('END_TIME_EXCEEDED')) problems.push(`tripImpact.conflicts 不含 END_TIME_EXCEEDED：${JSON.stringify(codes)}`);
      if (d.delayMin !== 80) problems.push(`delayMin=${d.delayMin}（应为 80 = 02:20 − 01:00）`);
      return problems.length
        ? fail(problems.join('；'))
        : pass(
            `canDepart=false checkId=${d.checkId} expiresAt=${d.expiresAt} delayMin=${d.delayMin} ` +
              `conflicts=${JSON.stringify(codes)} proposal=${d.proposal.proposalId}（可行候选 ${d.proposal.feasibleCount} 个）`
          );
    }),
    2: E.fail('INVALID_PARAM'),
    3: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const t = res.data.trip;
      return t.version === 5 && t.nodes.length === 3
        ? pass(`version=${t.version} nodes=${t.nodes.length} 个（检查过程没有落库改路线）`)
        : fail(`version=${t.version} nodes=${t.nodes.length}，应为 5 / 3`);
    }),
    4: E.ok({ applied: true, version: 6 }, '一次确认只涨一版：5 → 6'),
    5: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.canDepart !== true) problems.push(`canDepart=${d.canDepart}`);
      if (!d.checkId) problems.push('checkId 为空');
      if (d.proposal) problems.push('路线调整后仍带着提案（应当已经没有冲突）');
      return problems.length
        ? fail(problems.join('；'))
        : pass(`canDepart=true checkId=${d.checkId} expiresAt=${d.expiresAt} proposal=null`);
    }),
    6: E.ok({ status: 'departed' }, '写 ③ 实际出发时间'),
  },
  probes: [
    {
      id: 'P1',
      at: 0,
      why: 'invariant#3：只有发起人可以 prepareDepart / depart',
      actor: 'member-b',
      action: 'meet.prepareDepart',
      payload: { meetTaskId: 'meet-b' },
      expectedVersion: 1,
      expectCode: 'FORBIDDEN_NOT_MEMBER',
    },
    {
      id: 'P2',
      at: 0,
      why: 'invariant#3：只有发起人可以 prepareDepart / depart',
      actor: 'member-b',
      action: 'meet.depart',
      payload: { meetTaskId: 'meet-b' },
      expectedVersion: 1,
      expectCode: 'FORBIDDEN_NOT_MEMBER',
    },
    {
      id: 'P3',
      at: 1,
      why: 'invariant#1：canDepart=false 时不得出发（带上这次的 checkId 也必须被拒）',
      actor: 'owner-a',
      action: 'meet.depart',
      payload: { meetTaskId: 'meet-b', checkId: '<step1.checkId>' },
      expectedVersion: 1,
      expectCode: 'INFEASIBLE_HARD_CONSTRAINT',
      verify: async (ctx, res) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
        if (doc.departedAt !== null) return fail(`被拒了却写入了 departedAt=${iso(doc.departedAt)}`);
        if (doc.status !== 'arrived_all') return fail(`被拒了却把状态改成 ${doc.status}`);
        return pass('被拒且存储层 departedAt 仍为 null、status 仍为 arrived_all');
      },
    },
    {
      id: 'P4',
      at: 5,
      why: 'invariant#4：check 有有效期，expiresAt 之后必须重新检查',
      actor: 'owner-a',
      action: 'meet.depart',
      payload: { meetTaskId: 'meet-b', checkId: '<step5.checkId>' },
      expectedVersion: 1,
      nowFrom: { fromStep: 5, path: 'expiresAt', plusMin: 1 },
      expectCode: 'VERSION_CONFLICT',
      verify: async (ctx) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
        if (doc.departedAt !== null) return fail(`过期检查被拒了却写入了 departedAt=${iso(doc.departedAt)}`);
        return pass(`now=${ctx.probe('P4').now}（> expiresAt）：被拒且 departedAt 仍为 null`);
      },
    },
  ],
  invariants: [
    {
      text: 'canDepart=false 时不得出发：meet.depart 必须被拒且 departedAt 保持 null',
      checks: [
        {
          at: 2,
          desc: '不带 checkId 的 depart（案例第 2 步）',
          run: async (ctx) => {
            const res = ctx.resp(2);
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
            const problems = [];
            if (res.ok) problems.push('meet.depart 成功了');
            if (res.ok || res.error.code !== 'INVALID_PARAM') problems.push(`错误码=${res.ok ? '(成功)' : res.error.code}`);
            if (doc.departedAt !== null) problems.push(`存储 departedAt=${iso(doc.departedAt)}`);
            return problems.length ? fail(problems.join('；')) : pass('被拒 INVALID_PARAM（缺少本次检查），且 departedAt 仍为 null');
          },
        },
        {
          at: 1,
          desc: '带上 canDepart=false 的 checkId 再试一次（探针 P3）',
          run: async (ctx) => {
            const p = ctx.probe('P3');
            if (p.response.ok) return fail('canDepart=false 的检查却允许出发了');
            if (p.response.error.code !== 'INFEASIBLE_HARD_CONSTRAINT') {
              return fail(`被拒了，但错误码是 ${p.response.error.code}（应为 INFEASIBLE_HARD_CONSTRAINT）`);
            }
            return pass(`被拒 INFEASIBLE_HARD_CONSTRAINT：${p.response.error.message}；checkId 就是 step1 那次的`);
          },
        },
      ],
    },
    {
      text: '检查不可行不得自动改路线：提案生成后 trip.version 与 trip.nodes 必须保持不变，直到 trip.confirmChange 成功',
      checks: [
        {
          at: 1,
          desc: '第 1 步（prepareDepart，不可行）之后',
          run: async (ctx) => ctx.tripUnchanged('prepareDepart 生成提案之后'),
        },
        {
          at: 3,
          desc: '第 3 步（trip.get 复核）时',
          run: async (ctx) => ctx.tripUnchanged('被拒的 depart 之后仍然未变'),
        },
      ],
    },
    {
      text: '只有发起人（initiatorUserId）可以 prepareDepart / depart，成员调用必须 FORBIDDEN_NOT_MEMBER',
      checks: [
        {
          at: 0,
          desc: '成员 member-b 调 prepareDepart / depart（探针 P1 / P2）',
          run: async (ctx) => {
            const problems = [];
            for (const id of ['P1', 'P2']) {
              const p = ctx.probe(id);
              if (p.response.ok) problems.push(`${p.action} 对成员放行了`);
              else if (p.response.error.code !== 'FORBIDDEN_NOT_MEMBER') {
                problems.push(`${p.action} 返回 ${p.response.error.code}`);
              }
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass('member-b 调 prepareDepart 与 depart 都返回 FORBIDDEN_NOT_MEMBER');
          },
        },
      ],
    },
    {
      text: '出发必须携带 prepareDepart 返回的 checkId，且该检查未过期（check.expiresAt 之后必须重新检查）',
      checks: [
        {
          at: 2,
          desc: '缺 checkId → 拒绝',
          run: async (ctx) => {
            const res = ctx.resp(2);
            return !res.ok && res.error.code === 'INVALID_PARAM'
              ? pass(`缺 checkId 被拒：${res.error.message}`)
              : fail(`缺 checkId 时的响应：ok=${res.ok} code=${res.ok ? '-' : res.error.code}`);
          },
        },
        {
          at: 5,
          desc: 'check 过期（P4 把时钟推到 expiresAt+1min）→ 拒绝',
          run: async (ctx) => {
            const p = ctx.probe('P4');
            return !p.response.ok && p.response.error.code === 'VERSION_CONFLICT'
              ? pass(`过期检查被拒：${p.response.error.message}（now=${p.now}）`)
              : fail(`过期检查的响应：ok=${p.response.ok} code=${p.response.ok ? '-' : p.response.error.code}`);
          },
        },
        {
          at: 6,
          desc: '携带本次有效的 checkId → 放行',
          run: async (ctx) => {
            const d = ctx.data(6);
            return d.status === 'departed' && d.departedAt
              ? pass(`携带 step5 的 checkId 出发成功：departedAt=${d.departedAt}`)
              : fail(`status=${d.status} departedAt=${d.departedAt}`);
          },
        },
      ],
    },
    {
      text: 'delayMin 由「当前时刻 − plannedMeetAt」计算且不小于 0；不得由 allArrivedAt 推出',
      checks: [
        {
          at: 1,
          desc: '第 1 步的 delayMin',
          run: async (ctx) => {
            const d = ctx.data(1);
            const want = Math.max(0, Math.round((Date.parse(ctx.clock) - Date.parse('2026-10-20T01:00:00.000Z')) / 60000));
            const wrong = Math.round((Date.parse(ctx.clock) - Date.parse('2026-10-20T01:35:00.000Z')) / 60000);
            const problems = [];
            if (d.delayMin !== want) problems.push(`delayMin=${d.delayMin}，应为 ${want}`);
            if (d.delayMin === wrong) problems.push(`delayMin 等于「now − allArrivedAt」= ${wrong}，说明用错了基准`);
            if (d.tripImpact && d.tripImpact.delayMin !== want) {
              problems.push(`tripImpact.delayMin=${d.tripImpact.delayMin}，应为 ${want}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`delayMin=${d.delayMin} = now(02:20) − plannedMeetAt(01:00)；不是 now − allArrivedAt(${wrong})`);
          },
        },
      ],
    },
    {
      text: 'trip.version 必须由 5 变为 6（一次确认只涨一版）',
      checks: [
        {
          at: 4,
          desc: '确认之后',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-b');
            return trip.version === 6
              ? pass(`trip.version=6（第 3 步时还是 5，一次确认 +1）`)
              : fail(`trip.version=${trip.version}，应为 6`);
          },
        },
      ],
    },
  ],
  expectedStateChecks: [
    {
      at: 6,
      text: 'expectedState.meetTask：status=departed、version=1、plannedMeetAt 与 allArrivedAt 不变、departedAt 非空且晚于 allArrivedAt',
      run: async (ctx) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
        const problems = [];
        if (doc.status !== 'departed') problems.push(`status=${doc.status}`);
        if (doc.version !== 1) problems.push(`version=${doc.version}`);
        if (iso(doc.plannedMeetAt) !== '2026-10-20T01:00:00.000Z') problems.push(`plannedMeetAt=${iso(doc.plannedMeetAt)}`);
        if (iso(doc.allArrivedAt) !== '2026-10-20T01:35:00.000Z') problems.push(`allArrivedAt=${iso(doc.allArrivedAt)}`);
        if (!doc.departedAt) problems.push('departedAt 为空');
        else if (new Date(doc.departedAt) <= new Date(doc.allArrivedAt)) {
          problems.push(`departedAt(${iso(doc.departedAt)}) 不晚于 allArrivedAt(${iso(doc.allArrivedAt)})`);
        }
        return problems.length
          ? fail(problems.join('；'))
          : pass(
              `status=departed version=1 ①=${iso(doc.plannedMeetAt)} ②=${iso(doc.allArrivedAt)} ③=${iso(doc.departedAt)}（③ 晚于 ②）`
            );
      },
    },
    {
      at: 4,
      text: 'expectedState.proposal：status=confirmed、baseVersion=5、selectedCandidateId=<step4 确认的 candidateId>',
      run: async (ctx) => {
        const proposalId = ctx.data(1).proposal.proposalId;
        const doc = await ctx.repo.get(C.CHANGE_PROPOSALS, proposalId);
        const confirmedId = ctx.data(4).candidateId;
        const problems = [];
        if (!doc) problems.push('提案不存在');
        else {
          if (doc.status !== 'confirmed') problems.push(`status=${doc.status}`);
          if (doc.baseVersion !== 5) problems.push(`baseVersion=${doc.baseVersion}`);
          if (doc.selectedCandidateId !== confirmedId) problems.push(`selectedCandidateId=${doc.selectedCandidateId} ≠ ${confirmedId}`);
          if (doc.trigger && doc.trigger.type !== 'meet_delay') {
            problems.push(`trigger.type=${doc.trigger.type}（应由服务端写成 meet_delay）`);
          }
        }
        return problems.length
          ? fail(problems.join('；'))
          : pass(`提案 status=confirmed baseVersion=5 selectedCandidateId=${confirmedId} trigger.type=${doc.trigger && doc.trigger.type}`);
      },
    },
    {
      at: 5,
      text: 'expectedState.response.step5：canDepart=true，且 checkId 是**新的一次**检查',
      run: async (ctx) => {
        const d = ctx.data(5);
        const first = ctx.data(1).checkId;
        const problems = [];
        if (d.canDepart !== true) problems.push(`canDepart=${d.canDepart}`);
        if (!d.checkId) problems.push('checkId 为空');
        if (d.checkId === first) problems.push('checkId 与第 1 步相同，不是重新检查');
        return problems.length
          ? fail(problems.join('；'))
          : pass(`canDepart=true，新 checkId=${d.checkId}（第 1 步是 ${first}）`);
      },
    },
  ],
};

// ── replay-009 第二次修改继承第一次要求 ──────────────────────────
CASE_SPECS['replay-009'] = {
  observe: {
    1: [
      'proposalId',
      'baseVersion',
      'feasibleCount',
      'candidates[].candidateId',
      'candidates[].strategy',
      'candidates[].feasible',
      'candidates[].impact.changedEndAt',
      'candidates[].notes[].code',
    ],
    2: ['applied', 'version', 'candidateId', 'changes[].code', 'plannedEndAt'],
    3: [
      'proposalId',
      'baseVersion',
      'feasibleCount',
      'candidates[].candidateId',
      'candidates[].strategy',
      'candidates[].feasible',
      'candidates[].impact.changedEndAt',
      'candidates[].notes[].code',
    ],
    4: ['applied', 'version', 'candidateId', 'changes[].code', 'plannedEndAt'],
    5: [
      'trip.version',
      'trip.plannedEndAt',
      'trip.constraints[].key',
      'trip.constraints[].hardness',
      'trip.constraints[].confirmedAt',
      'trip.nodes[].placeId',
      'trip.nodes[].plannedStayMin',
      'trip.nodes[].status',
    ],
  },
  expect: {
    1: E.ok({ baseVersion: 3, applied: false }, 'trip.adjust 不落库改路线，只出提案'),
    2: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.applied !== true) problems.push(`applied=${d.applied}`);
      if (d.version !== 4) problems.push(`version=${d.version}（应为 4）`);
      if (!Array.isArray(d.changes) || d.changes.length === 0) problems.push('changes 为空（"改了什么"必须给出）');
      return problems.length
        ? fail(problems.join('；'))
        : pass(`applied=true version=4 changes=${JSON.stringify(d.changes.map((c) => c.code))}`);
    }),
    3: E.ok({ baseVersion: 4, applied: false }, '第二次修改必须基于第一次确认后的版本 4'),
    4: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.applied !== true) problems.push(`applied=${d.applied}`);
      if (d.version !== 5) problems.push(`version=${d.version}（应为 5）`);
      if (!Array.isArray(d.changes) || d.changes.length === 0) problems.push('changes 为空');
      return problems.length
        ? fail(problems.join('；'))
        : pass(`applied=true version=5 changes=${JSON.stringify(d.changes.map((c) => c.code))}`);
    }),
    5: E.ok({ 'trip.version': 5 }, '两次修改各 +1 版：3 → 4 → 5'),
  },
  probes: [
    {
      id: 'P1',
      at: 3,
      why: 'invariant#4：trip.confirmChange 必须携带**信封** expectedVersion',
      actor: 'owner-a',
      action: 'trip.confirmChange',
      payload: {
        proposalId: '<step3.proposalId>',
        candidateId: '<step3.candidates 中 feasible=true 的 candidateId>',
      },
      expectedVersion: null,
      expectCode: 'INVALID_PARAM',
      verify: async (ctx) => {
        const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
        return trip.version === 4
          ? pass(`缺信封版本被拒，且 trip.version 仍为 4（没有静默按当前版本执行）`)
          : fail(`缺信封版本却改了版本：trip.version=${trip.version}`);
      },
    },
    {
      id: 'P2',
      at: 5,
      why: 'invariant#5：不可行候选必须被拒（用案例白名单里的 skip_node 命中 mustVisit，构造出不可行候选）',
      actor: 'owner-a',
      action: 'trip.adjust',
      payload: { tripId: 'trip-a', trigger: { type: 'skip_node', payload: { nodeId: 'node-c' } } },
      expectedVersion: null,
      expectOk: true,
      expectOkCheck: (res) => {
        const d = res.data;
        const infeasible = (d.candidates || []).filter((c) => c.feasible === false);
        if (!d.candidates || !d.candidates.length) return fail('skip_node 未产生任何候选');
        if (!infeasible.length) {
          return fail(
            `期望产生不可行候选（skip_node 命中 mustVisit=place-c），实际候选 feasible=${JSON.stringify(
              d.candidates.map((c) => c.feasible)
            )}`
          );
        }
        return pass(
          `候选 ${d.candidates.length} 个、其中不可行 ${infeasible.length} 个，冲突码=${JSON.stringify(
            infeasible[0].conflicts.map((c) => c.code)
          )}`
        );
      },
    },
    {
      id: 'P3',
      at: 5,
      why: 'invariant#5：可行候选才能生效 —— 确认不可行候选必须 INFEASIBLE_HARD_CONSTRAINT',
      actor: 'owner-a',
      action: 'trip.confirmChange',
      payload: {
        proposalId: '<probe2.proposalId>',
        candidateId: '<probe2.candidates 中 feasible=false 的 candidateId>',
      },
      expectedVersion: 5,
      expectCode: 'INFEASIBLE_HARD_CONSTRAINT',
      verify: async (ctx) => {
        const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
        /** 比的是"这一步之前"的行程 —— 两次确认**本来就**改过 nodes，不能拿夹具当基线 */
        const before = ctx.snapshotAfterStep[5];
        const problems = [];
        if (trip.version !== 5) problems.push(`trip.version=${trip.version}`);
        if (!before) problems.push('缺少第 5 步的行程快照');
        else if (canon(trip.nodes) !== canon(before.nodes)) problems.push('trip.nodes 被改写了');
        if (canon(trip.constraints) !== canon(ctx.initial.trip.constraints)) problems.push('trip.constraints 被改写了');
        return problems.length
          ? fail(`确认不可行候选虽被拒，但状态被改：${problems.join('；')}`)
          : pass('确认不可行候选被拒，且 trip.version / nodes / constraints 全部未变');
      },
    },
  ],
  invariants: [
    {
      text: '第二次 trip.adjust 记录的 baseVersion 必须等于第一次确认后的 trip.version（4），不得回落到 3',
      checks: [
        {
          at: 3,
          desc: '第 3 步响应与存储的提案',
          run: async (ctx) => {
            const resp = ctx.data(3);
            const doc = await ctx.repo.get(C.CHANGE_PROPOSALS, resp.proposalId);
            const problems = [];
            if (resp.baseVersion !== 4) problems.push(`响应 baseVersion=${resp.baseVersion}`);
            if (doc.baseVersion !== 4) problems.push(`存储 baseVersion=${doc.baseVersion}`);
            if (resp.baseVersion === 3) problems.push('回落到了第一次之前的基线 3');
            return problems.length
              ? fail(problems.join('；'))
              : pass(`第二次 adjust 的 baseVersion=4（响应与存储一致），未回落到 3`);
          },
        },
      ],
    },
    {
      text: '两次确认各使 trip.version 恰好 +1（3 → 4 → 5），不得跳版或原地不动',
      checks: [
        {
          at: 1,
          desc: '第一次 adjust 之后（未确认）',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            return trip.version === 3 ? pass('提案生成后仍是 version=3') : fail(`version=${trip.version}`);
          },
        },
        {
          at: 2,
          desc: '第一次确认之后',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            return trip.version === 4 ? pass('3 → 4') : fail(`version=${trip.version}，应为 4`);
          },
        },
        {
          at: 4,
          desc: '第二次确认之后',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            return trip.version === 5 ? pass('4 → 5（每次确认恰好 +1）') : fail(`version=${trip.version}，应为 5`);
          },
        },
      ],
    },
    {
      text: '两次修改后 trip.constraints 必须仍含 endAt 与 mustVisit，且 hardness=hard、confirmedAt 非空',
      checks: [
        {
          at: 5,
          desc: '存储层 constraints',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            const keys = (trip.constraints || []).map((c) => c.key);
            const problems = [];
            for (const key of ['endAt', 'mustVisit']) {
              const c = (trip.constraints || []).find((x) => x.key === key);
              if (!c) problems.push(`缺少 ${key}`);
              else {
                if (c.hardness !== 'hard') problems.push(`${key}.hardness=${c.hardness}`);
                if (c.confirmedAt == null) problems.push(`${key}.confirmedAt 为空`);
              }
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`constraints 仍含 ${JSON.stringify(keys)}，hardness 均为 hard 且 confirmedAt 非空`);
          },
        },
      ],
    },
    {
      text: 'trip.confirmChange 必须携带信封 expectedVersion，且等于提案的 baseVersion 与当时的 trip.version',
      checks: [
        {
          at: 2,
          desc: '第一次确认：信封 3 = 提案 baseVersion 3 = 当时 trip.version 3',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            const proposal = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(1).proposalId);
            const problems = [];
            if (ctx.step(2).expectedVersion !== 3) problems.push(`步骤信封=${ctx.step(2).expectedVersion}`);
            if (proposal.baseVersion !== 3) problems.push(`提案 baseVersion=${proposal.baseVersion}`);
            if (trip.version !== 4) problems.push(`确认后 version=${trip.version}（应为 4）`);
            return problems.length
              ? fail(problems.join('；'))
              : pass('信封 expectedVersion=3 = 提案 baseVersion=3，确认后 version=4');
          },
        },
        {
          at: 4,
          desc: '第二次确认：信封 4 = 提案 baseVersion 4',
          run: async (ctx) => {
            const proposal = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(3).proposalId);
            const problems = [];
            if (ctx.step(4).expectedVersion !== 4) problems.push(`步骤信封=${ctx.step(4).expectedVersion}`);
            if (proposal.baseVersion !== 4) problems.push(`提案 baseVersion=${proposal.baseVersion}`);
            return problems.length ? fail(problems.join('；')) : pass('信封 expectedVersion=4 = 提案 baseVersion=4');
          },
        },
        {
          at: 3,
          desc: '缺信封版本必须被拒（探针 P1）——这是"版本校验真的生效"的反证',
          run: async (ctx) => {
            const p = ctx.probe('P1');
            return !p.response.ok && p.response.error.code === 'INVALID_PARAM'
              ? pass(`缺 expectedVersion 被拒：${p.response.error.message}`)
              : fail(`缺 expectedVersion 的响应：ok=${p.response.ok} code=${p.response.ok ? '-' : p.response.error.code}`);
          },
        },
        {
          at: 5,
          desc: '所有步骤的 payload 都不含 expectedVersion（它只属于信封）',
          run: async (ctx) => {
            const bad = ctx.steps
              .filter((s) => s.resolvedPayload && Object.prototype.hasOwnProperty.call(s.resolvedPayload, 'expectedVersion'))
              .map((s) => s.step);
            return bad.length
              ? fail(`第 ${bad.join('、')} 步把 expectedVersion 写进了 payload —— 版本校验会静默失效`)
              : pass('六条案例的全部步骤 payload 都没有 expectedVersion 这个键');
          },
        },
      ],
    },
    {
      text: '只有 feasible=true 的候选可以生效；不可行候选必须被拒（INFEASIBLE_HARD_CONSTRAINT）',
      checks: [
        {
          at: 5,
          desc: '已生效的候选必须是可行的',
          run: async (ctx) => {
            const problems = [];
            for (const [stepNo, proposalPath] of [
              [2, 1],
              [4, 3],
            ]) {
              const proposal = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(proposalPath).proposalId);
              const chosen = (proposal.candidates || []).find((c) => c.candidateId === proposal.selectedCandidateId);
              if (!chosen) problems.push(`第 ${proposalPath} 步的提案找不到已选候选`);
              else if (chosen.feasible !== true) problems.push(`第 ${proposalPath} 步生效的候选 feasible=${chosen.feasible}`);
              if (proposal.status !== 'confirmed') problems.push(`第 ${proposalPath} 步的提案 status=${proposal.status}`);
            }
            return problems.length ? fail(problems.join('；')) : pass('两次生效的候选 feasible 均为 true、提案均为 confirmed');
          },
        },
        {
          at: 5,
          desc: '不可行候选被拒（探针 P2 造出不可行候选，P3 尝试确认）',
          run: async (ctx) => {
            const p2 = ctx.probe('P2');
            const p3 = ctx.probe('P3');
            const infeasible = (p2.response.ok ? p2.response.data.candidates : []).filter((c) => c.feasible === false);
            if (!infeasible.length) return fail('探针 P2 没有造出不可行候选，这条断言未被真正验证');
            if (p3.response.ok) return fail('不可行候选被确认生效了');
            if (p3.response.error.code !== 'INFEASIBLE_HARD_CONSTRAINT') {
              return fail(`确认不可行候选返回 ${p3.response.error.code}，应为 INFEASIBLE_HARD_CONSTRAINT`);
            }
            return pass(
              `skip_node 命中 mustVisit=place-c 产生不可行候选（conflicts=${JSON.stringify(
                infeasible[0].conflicts.map((c) => c.code)
              )}），确认时被拒：${p3.response.error.message}`
            );
          },
        },
      ],
    },
    {
      text: '每个候选必须带 impact 与 notes（改了什么必须可解释）',
      checks: [
        {
          at: 4,
          desc: '两次 adjust 的提案候选',
          run: async (ctx) => {
            const problems = [];
            let checked = 0;
            for (const stepNo of [1, 3]) {
              const proposal = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(stepNo).proposalId);
              for (const c of proposal.candidates || []) {
                checked++;
                if (!c.impact || typeof c.impact !== 'object') problems.push(`第 ${stepNo} 步 ${c.candidateId} 缺 impact`);
                else if (c.impact.changedEndAt == null) problems.push(`第 ${stepNo} 步 ${c.candidateId} 的 impact.changedEndAt 为空`);
                if (!Array.isArray(c.notes) || !c.notes.length) problems.push(`第 ${stepNo} 步 ${c.candidateId} 的 notes 为空`);
              }
            }
            if (!checked) problems.push('没有任何候选可检查');
            return problems.length
              ? fail(problems.join('；'))
              : pass(`${checked} 个候选都带 impact（含 changedEndAt）与非空 notes`);
          },
        },
      ],
    },
    {
      text: 'trip.adjust 本身不落库改路线：提案生成后 trip.version 与 trip.nodes 不变，直到 confirmChange 成功',
      checks: [
        {
          at: 1,
          desc: '第一次 adjust 之后',
          run: async (ctx) => ctx.tripUnchanged('第一次 adjust 生成提案之后'),
        },
        {
          at: 3,
          desc: '第二次 adjust（第一次已确认）之后',
          run: async (ctx) => {
            const cur = await ctx.repo.get(C.TRIPS, 'trip-a');
            const afterFirstConfirm = ctx.snapshotAfterStep[2];
            if (!afterFirstConfirm) return fail('缺少第一次确认之后的快照');
            return canon(cur) === canon(afterFirstConfirm)
              ? pass('第二次 adjust 没有改动 trip（与第一次确认后的快照逐字段一致）')
              : fail(`trip 被改写了：\n  现在 ${trim(canon(cur))}\n  期望 ${trim(canon(afterFirstConfirm))}`);
          },
        },
      ],
    },
  ],
  expectedStateChecks: [
    {
      at: 5,
      text: 'expectedState.trip：version=5、node-b 的 plannedStayMin 等于两次修改的净效果（45+30−20=55）、node-c 仍在行程里',
      run: async (ctx) => {
        const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
        const nodeB = trip.nodes.find((n) => n.nodeId === 'node-b');
        const nodeC = trip.nodes.find((n) => n.nodeId === 'node-c');
        const problems = [];
        if (trip.version !== 5) problems.push(`version=${trip.version}`);
        if (!nodeB) problems.push('node-b 不在行程里');
        else if (nodeB.plannedStayMin !== 55) problems.push(`node-b.plannedStayMin=${nodeB.plannedStayMin}（净效果应为 45+30−20=55）`);
        if (!nodeC) problems.push('node-c 不在行程里（mustVisit 未被满足）');
        return problems.length
          ? fail(problems.join('；'))
          : pass(`version=5 node-b.plannedStayMin=${nodeB.plannedStayMin}（45+30−20）node-c 仍在（${nodeC.placeId}）`);
      },
    },
    {
      at: 4,
      text: 'expectedState.proposal：两次提案 status=confirmed，baseVersion 分别为 3 与 4',
      run: async (ctx) => {
        const p1 = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(1).proposalId);
        const p2 = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(3).proposalId);
        const problems = [];
        if (p1.status !== 'confirmed') problems.push(`提案1 status=${p1.status}`);
        if (p1.baseVersion !== 3) problems.push(`提案1 baseVersion=${p1.baseVersion}`);
        if (p2.status !== 'confirmed') problems.push(`提案2 status=${p2.status}`);
        if (p2.baseVersion !== 4) problems.push(`提案2 baseVersion=${p2.baseVersion}`);
        return problems.length
          ? fail(problems.join('；'))
          : pass('提案1 confirmed/baseVersion=3，提案2 confirmed/baseVersion=4');
      },
    },
  ],
};

// ── replay-013 成员确认旧版本 ───────────────────────────────────
CASE_SPECS['replay-013'] = {
  observe: {
    1: ['myConfirmationValid', 'staleConfirmations[].userId', 'meetTask.version', 'meetTask.status'],
    2: ['error.code', 'error.message'],
    3: ['version', 'status', 'myStatus', 'confirmedCount', 'participantCount', 'allConfirmed'],
    4: ['staleConfirmations[].userId', 'meetTask.version', 'meetTask.participants[].confirmedVersion'],
  },
  expect: {
    1: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.myConfirmationValid !== false) problems.push(`myConfirmationValid=${d.myConfirmationValid}`);
      const stale = (d.staleConfirmations || []).map((x) => x.userId);
      if (!stale.length) problems.push('staleConfirmations 为空');
      if (!stale.includes('member-b')) problems.push(`staleConfirmations 不含 member-b：${JSON.stringify(stale)}`);
      return problems.length
        ? fail(problems.join('；'))
        : pass(`myConfirmationValid=false，失效名单=${JSON.stringify(stale)}`);
    }),
    2: E.fail('VERSION_CONFLICT'),
    3: E.ok({ version: 2, status: 'confirmed', myStatus: 'confirmed', allConfirmed: false }, '其余两人仍是旧版本'),
    4: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const stale = (res.data.staleConfirmations || []).map((x) => x.userId);
      const problems = [];
      for (const u of ['owner-a', 'member-c']) if (!stale.includes(u)) problems.push(`失效名单缺少 ${u}`);
      if (stale.includes('member-b')) problems.push('member-b 已按当前版本重新确认，不应再算失效');
      return problems.length ? fail(problems.join('；')) : pass(`失效名单=${JSON.stringify(stale)}（含 owner-a/member-c，不含 member-b）`);
    }),
  },
  probes: [
    {
      id: 'P1',
      at: 0,
      why: 'invariant#2：确认必须携带**信封** expectedVersion（本项目真实缺陷的回归点）',
      actor: 'member-b',
      action: 'meet.confirm',
      payload: { meetTaskId: 'meet-a', decision: 'confirm' },
      expectedVersion: null,
      expectCode: 'INVALID_PARAM',
      verify: async (ctx) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
        const b = doc.participants.find((p) => p.userId === 'member-b');
        return b.confirmedVersion === 1 && iso(b.confirmedAt) === '2026-10-19T12:05:00.000Z'
          ? pass('缺信封版本被拒，且没有写入任何 confirmedVersion / confirmedAt')
          : fail(`被拒却改了参与者：confirmedVersion=${b.confirmedVersion} confirmedAt=${iso(b.confirmedAt)}`);
      },
    },
  ],
  invariants: [
    {
      text: '夹具初始状态必须原样注入（meetTask.version=2 且三名参与者 confirmedVersion=1）；不得用允许的 action 伪造该版本',
      checks: [
        {
          at: 0,
          desc: '步骤开始前读存储层',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const problems = [];
            if (doc.version !== 2) problems.push(`version=${doc.version}`);
            for (const p of doc.participants) {
              if (p.confirmedVersion !== 1) problems.push(`${p.userId}.confirmedVersion=${p.confirmedVersion}`);
            }
            const injected = ctx.initial.meetTask;
            if (canon(doc) !== canon(injected)) problems.push('存储层与注入的夹具不一致');
            return problems.length
              ? fail(problems.join('；'))
              : pass(
                  'version=2，三名参与者 confirmedVersion 均为 1，且存储层与注入的夹具逐字段一致 ' +
                    '（`actionVocabulary` 里没有任何 action 能产生"已升版 + 旧确认"这个状态 —— 只能夹具注入）'
                );
          },
        },
      ],
    },
    {
      text: '确认必须携带信封 expectedVersion；与任务当前版本不一致时必须 VERSION_CONFLICT，且不得写入任何 confirmedVersion',
      checks: [
        {
          at: 2,
          desc: '旧版本确认（信封 1 vs 任务 version 2）与存储层复核',
          run: async (ctx) => {
            const res = ctx.resp(2);
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const problems = [];
            if (res.ok) problems.push('旧版本确认却成功了');
            else if (res.error.code !== 'VERSION_CONFLICT') problems.push(`错误码=${res.error.code}`);
            for (const p of doc.participants) {
              if (p.confirmedVersion !== 1) problems.push(`${p.userId}.confirmedVersion=${p.confirmedVersion}`);
              if (p.status !== 'confirmed') problems.push(`${p.userId}.status=${p.status}`);
            }
            const b = doc.participants.find((p) => p.userId === 'member-b');
            if (iso(b.confirmedAt) !== '2026-10-19T12:05:00.000Z') problems.push(`member-b.confirmedAt=${iso(b.confirmedAt)}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass(`被拒 ${res.error.code}：${res.error.message}；存储层三名参与者 confirmedVersion 仍全为 1、confirmedAt 未刷新`);
          },
        },
        {
          at: 0,
          desc: '缺信封版本也必须被拒（探针 P1）',
          run: async (ctx) => {
            const p = ctx.probe('P1');
            return !p.response.ok && p.response.error.code === 'INVALID_PARAM'
              ? pass(`缺 expectedVersion 被拒：${p.response.error.message}`)
              : fail(`缺 expectedVersion：ok=${p.response.ok} code=${p.response.ok ? '-' : p.response.error.code}`);
          },
        },
      ],
    },
    {
      text: '有效确认只统计 confirmedVersion === version 的参与者，确认版本不等于当前版本者一律不算',
      checks: [
        {
          at: 3,
          desc: '第 3 步之后按存储层现算有效确认',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const effective = doc.participants.filter((p) => p.status === 'confirmed' && p.confirmedVersion === doc.version);
            const stale = doc.participants.filter((p) => p.status === 'confirmed' && p.confirmedVersion !== doc.version);
            const resp = ctx.data(3);
            const problems = [];
            if (effective.length !== 1) problems.push(`有效确认 ${effective.length} 人（应为 1）`);
            if (resp.confirmedCount !== effective.length) problems.push(`响应 confirmedCount=${resp.confirmedCount}`);
            const effectiveIds = effective.map((p) => p.userId);
            if (effectiveIds[0] !== 'member-b') problems.push(`有效确认者是 ${JSON.stringify(effectiveIds)}`);
            if (stale.map((p) => p.userId).sort().join(',') !== 'member-c,owner-a') {
              problems.push(`失效名单=${JSON.stringify(stale.map((p) => p.userId))}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`有效确认=1（member-b，confirmedVersion=2=version）；失效=2（owner-a/member-c，confirmedVersion=1）`);
          },
        },
      ],
    },
    {
      text: 'meet.get 必须如实告知失效：myConfirmationValid=false、staleConfirmations 非空',
      checks: [
        {
          at: 1,
          desc: 'member-b 打开集合页（第 1 步）',
          run: async (ctx) => {
            const d = ctx.data(1);
            const stale = (d.staleConfirmations || []).map((x) => x.userId);
            const problems = [];
            if (d.myConfirmationValid !== false) problems.push(`myConfirmationValid=${d.myConfirmationValid}`);
            if (!stale.length) problems.push('staleConfirmations 为空');
            if (!stale.includes('member-b')) problems.push('失效名单里没有 member-b（自己失效了却不说）');
            return problems.length
              ? fail(problems.join('；'))
              : pass(`myConfirmationValid=false，staleConfirmations=${JSON.stringify(stale)}`);
          },
        },
        {
          at: 4,
          desc: '发起人读取（第 4 步）',
          run: async (ctx) => {
            const stale = (ctx.data(4).staleConfirmations || []).map((x) => x.userId);
            const problems = [];
            for (const u of ['owner-a', 'member-c']) if (!stale.includes(u)) problems.push(`缺少 ${u}`);
            if (stale.includes('member-b')) problems.push('member-b 不应再算失效');
            return problems.length ? fail(problems.join('；')) : pass(`staleConfirmations=${JSON.stringify(stale)}`);
          },
        },
      ],
    },
    {
      text: '确认本身不改变 meetTask.version（版本由集合内容变化驱动，不由确认驱动）',
      checks: [
        {
          at: 2,
          desc: '被拒的确认之后',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            return doc.version === 2 ? pass('被拒之后 version 仍为 2') : fail(`version=${doc.version}`);
          },
        },
        {
          at: 3,
          desc: '成功的确认之后',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const resp = ctx.data(3);
            const problems = [];
            if (doc.version !== 2) problems.push(`存储 version=${doc.version}`);
            if (resp.version !== 2) problems.push(`响应 version=${resp.version}`);
            if (doc.revision !== 1) problems.push(`revision=${doc.revision}（本次确认应把 revision 推进到 1）`);
            return problems.length
              ? fail(problems.join('；'))
              : pass('确认前后 version 都是 2（revision 1 → 确认只推进 revision，不推进 version）')
          },
        },
      ],
    },
    {
      text: '部分成员重新确认后 allConfirmed 仍为 false，集合状态不得提前推进',
      checks: [
        {
          at: 3,
          desc: '第 3 步响应 + 存储层状态',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const resp = ctx.data(3);
            const problems = [];
            if (resp.allConfirmed !== false) problems.push(`响应 allConfirmed=${resp.allConfirmed}`);
            if (doc.status !== 'confirmed') problems.push(`存储 status=${doc.status}`);
            if (doc.allArrivedAt !== null) problems.push(`allArrivedAt=${iso(doc.allArrivedAt)}`);
            if (doc.departedAt !== null) problems.push(`departedAt=${iso(doc.departedAt)}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass('allConfirmed=false，status 仍为 confirmed，② ③ 都未写（没有提前推进集合状态）');
          },
        },
      ],
    },
  ],
  expectedStateChecks: [
    {
      at: 4,
      text: 'expectedState.meetTask/trip：member-b confirmedVersion=2 且 confirmedAt=第 3 步时刻；owner-a/member-c 仍为 1；departedAt=null；plannedMeetAt 不变；trip.version=3',
      run: async (ctx) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
        const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
        const b = doc.participants.find((p) => p.userId === 'member-b');
        const problems = [];
        if (b.confirmedVersion !== 2) problems.push(`member-b.confirmedVersion=${b.confirmedVersion}`);
        if (iso(b.confirmedAt) !== ctx.clock) problems.push(`member-b.confirmedAt=${iso(b.confirmedAt)} ≠ 步骤 3 的服务端时刻 ${ctx.clock}`);
        for (const u of ['owner-a', 'member-c']) {
          const p = doc.participants.find((x) => x.userId === u);
          if (p.confirmedVersion !== 1) problems.push(`${u}.confirmedVersion=${p.confirmedVersion}`);
        }
        if (doc.departedAt !== null) problems.push(`departedAt=${iso(doc.departedAt)}`);
        if (iso(doc.plannedMeetAt) !== '2026-10-20T01:00:00.000Z') problems.push(`plannedMeetAt=${iso(doc.plannedMeetAt)}`);
        if (trip.version !== 3) problems.push(`trip.version=${trip.version}`);
        return problems.length
          ? fail(problems.join('；'))
          : pass('member-b confirmedVersion=2（confirmedAt=第 3 步时刻），owner-a/member-c 仍为 1，departedAt=null，trip.version=3');
      },
    },
  ],
};

// ── replay-017 成员退出、位置过期 ────────────────────────────────
CASE_SPECS['replay-017'] = {
  observe: {
    1: ['revoked', 'memberCount', 'leftAt'],
    2: ['error.code', 'error.message'],
    3: ['error.code', 'error.message'],
    4: ['error.code', 'error.message'],
    5: ['crew.memberCount', 'members[].userId', 'members[].role', 'members[].locationSharing'],
    6: ['members[].userId', 'members[].hasLocation', 'members[].stale'],
    7: ['joined', 'role', 'memberCount'],
    8: ['crew.memberCount', 'members[].userId', 'members[].locationSharing'],
    9: ['meetTask.status', 'meetTask.version', 'meetTask.participants[].userId', 'meetTask.participants[].status'],
  },
  expect: {
    1: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.revoked !== true) problems.push(`revoked=${d.revoked}`);
      if (d.memberCount !== 2) problems.push(`memberCount=${d.memberCount}`);
      if (!d.leftAt) problems.push('leftAt 为空');
      return problems.length ? fail(problems.join('；')) : pass(`revoked=true memberCount=2 leftAt=${d.leftAt}`);
    }),
    2: E.fail('FORBIDDEN_NOT_MEMBER'),
    3: E.fail('FORBIDDEN_NOT_MEMBER'),
    4: E.fail('FORBIDDEN_NOT_MEMBER'),
    5: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const ids = res.data.members.map((m) => m.userId).sort();
      const problems = [];
      if (res.data.crew.memberCount !== 2) problems.push(`memberCount=${res.data.crew.memberCount}`);
      if (ids.join(',') !== 'member-b,owner-a') problems.push(`成员名单=${JSON.stringify(ids)}`);
      return problems.length ? fail(problems.join('；')) : pass(`memberCount=2，成员=[${ids.join(', ')}]`);
    }),
    6: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const ids = res.data.members.map((m) => m.userId);
      const problems = [];
      if (ids.includes('member-c')) problems.push('列表中仍有已退出的 member-c');
      for (const u of ['owner-a', 'member-b']) if (!ids.includes(u)) problems.push(`列表中缺少 ${u}`);
      return problems.length ? fail(problems.join('；')) : pass(`loc.list 成员=[${ids.join(', ')}]（无 member-c）`);
    }),
    7: E.ok({ joined: true, role: 'member', memberCount: 3 }, '复用原成员记录重新加入'),
    8: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const c = res.data.members.find((m) => m.userId === 'member-c');
      const problems = [];
      if (res.data.crew.memberCount !== 3) problems.push(`memberCount=${res.data.crew.memberCount}`);
      if (!c) problems.push('成员名单里没有 member-c');
      else if (c.role !== 'member') problems.push(`member-c.role=${c.role}`);
      else if (c.locationSharing !== false) problems.push(`member-c.locationSharing=${c.locationSharing}`);
      return problems.length
        ? fail(problems.join('；'))
        : pass(`memberCount=3，member-c 回到名单（role=member, locationSharing=false，须重新主动开启）`);
    }),
    9: E.ok({ 'meetTask.status': 'confirmed', 'meetTask.version': 1 }, '重新加入不等于回到该次集合的参与名单'),
  },
  probes: [
    {
      id: 'P1',
      at: 0,
      why: 'invariant#4：退出者不得再出现在 loc.list 里 —— 先证明"退出前是看得到的"，否则第 6 步可能是空列表带来的假通过',
      actor: 'owner-a',
      action: 'loc.list',
      payload: { crewId: 'crew-a' },
      expectedVersion: null,
      expectOk: true,
      expectOkCheck: (res) => {
        const members = res.data.members || [];
        const visible = members.filter((m) => m.hasLocation === true && m.point);
        if (visible.length !== members.length) {
          return fail(
            `夹具里的位置没有被读取路径看到：${JSON.stringify(members.map((m) => ({ userId: m.userId, hasLocation: m.hasLocation })))}`
          );
        }
        return pass(
          `退出前 loc.list 返回 ${members.length} 人且都有坐标：${JSON.stringify(members.map((m) => m.userId))}`
        );
      },
    },
  ],
  invariants: [
    {
      text: '退出立即生效：该成员之后的任何队伍读取/写入必须 FORBIDDEN_NOT_MEMBER（成员身份不得缓存）',
      checks: [
        {
          at: 4,
          desc: '退出后的 crew.get / loc.list / loc.report（第 2、3、4 步）',
          run: async (ctx) => {
            const problems = [];
            for (const n of [2, 3, 4]) {
              const res = ctx.resp(n);
              const action = ctx.step(n).action;
              if (res.ok) problems.push(`${action} 对已退出的 member-c 放行了`);
              else if (res.error.code !== 'FORBIDDEN_NOT_MEMBER') problems.push(`${action} 返回 ${res.error.code}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass('crew.get / loc.list / loc.report 三个调用全部 FORBIDDEN_NOT_MEMBER');
          },
        },
        {
          at: 4,
          desc: '退出后的位置上报没有落库',
          run: async (ctx) => {
            const locs = await ctx.repo.find(C.LOCATIONS, { userId: 'member-c' });
            const after = locs.filter((l) => new Date(l.reportedAt) > new Date(ctx.clock));
            return after.length === 0
              ? pass(`member-c 的位置记录仍是夹具那 ${locs.length} 条，没有新增`)
              : fail(`被拒的上报却写入了 ${after.length} 条位置记录`);
          },
        },
      ],
    },
    {
      text: 'crew.memberCount 必须等于 status === \'active\' 的成员数',
      checks: [
        {
          at: 1,
          desc: '退出之后',
          run: async (ctx) => {
            const crew = await ctx.repo.get(C.CREWS, 'crew-a');
            const active = await ctx.repo.count(C.CREW_MEMBERS, { crewId: 'crew-a', status: 'active' });
            const problems = [];
            if (crew.memberCount !== active) problems.push(`存储 memberCount=${crew.memberCount} ≠ 实际 active=${active}`);
            if (ctx.data(1).memberCount !== active) problems.push(`响应 memberCount=${ctx.data(1).memberCount}`);
            if (active !== 2) problems.push(`active 成员数=${active}，应为 2`);
            return problems.length ? fail(problems.join('；')) : pass(`memberCount=2 = active 成员数 2`);
          },
        },
        {
          at: 8,
          desc: '重新加入之后',
          run: async (ctx) => {
            const crew = await ctx.repo.get(C.CREWS, 'crew-a');
            const active = await ctx.repo.count(C.CREW_MEMBERS, { crewId: 'crew-a', status: 'active' });
            const problems = [];
            if (crew.memberCount !== active) problems.push(`存储 memberCount=${crew.memberCount} ≠ 实际 active=${active}`);
            if (ctx.data(7).memberCount !== active) problems.push(`step7 响应 memberCount=${ctx.data(7).memberCount}`);
            if (active !== 3) problems.push(`active 成员数=${active}，应为 3`);
            return problems.length ? fail(problems.join('；')) : pass(`memberCount=3 = active 成员数 3`);
          },
        },
      ],
    },
    {
      text: "退出即停止位置共享（存储层 locationSharing=false 且 status='left'），不得等用户手动关闭",
      checks: [
        {
          at: 1,
          desc: '存储层的 member-c 记录',
          run: async (ctx) => {
            const m = await ctx.repo.findOne(C.CREW_MEMBERS, { crewId: 'crew-a', userId: 'member-c' });
            ctx.capture('member-c.locationSharing.afterLeave', m.locationSharing);
            ctx.capture('member-c.status.afterLeave', m.status);
            const problems = [];
            if (!m) problems.push('找不到 member-c 的成员记录');
            else {
              if (m.status !== 'left') problems.push(`status=${m.status}`);
              if (m.locationSharing !== false) problems.push(`locationSharing=${m.locationSharing}`);
              if (!m.leftAt) problems.push('leftAt 为空');
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`status=left locationSharing=false leftAt=${iso(m.leftAt)}（退出即撤销，不需要额外动作）`);
          },
        },
      ],
    },
    {
      text: '退出者不得再出现在 loc.list 的返回里',
      checks: [
        {
          at: 6,
          desc: '发起人读取队伍位置（第 6 步）+ 退出前的基线（探针 P1）',
          run: async (ctx) => {
            const before = ctx.probe('P1').response.data.members.map((m) => m.userId);
            const after = ctx.data(6).members.map((m) => m.userId);
            const problems = [];
            if (!before.includes('member-c')) problems.push(`退出前就看不到 member-c（${JSON.stringify(before)}），这条断言会假通过`);
            if (after.includes('member-c')) problems.push('退出后仍能看到 member-c');
            for (const u of ['owner-a', 'member-b']) if (!after.includes(u)) problems.push(`退出后列表里少了 ${u}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass(`退出前=[${before.join(', ')}] → 退出后=[${after.join(', ')}]（member-c 消失，其余仍在）`);
          },
        },
        {
          at: 6,
          desc: '退出者即使还有历史坐标也不得返回',
          run: async (ctx) => {
            const rows = await ctx.repo.find(C.LOCATIONS, { userId: 'member-c', crewId: 'crew-a' });
            const hasCol = ctx.data(6).members.some((m) => m.userId === 'member-c');
            if (!rows.length) return fail('夹具里没有 member-c 的位置记录，这条断言未被真正验证');
            return hasCol
              ? fail(`member-c 仍有 ${rows.length} 条位置记录且仍被返回`)
              : pass(`member-c 仍有 ${rows.length} 条历史位置记录，但 loc.list 不再返回它（按 active 成员遍历）`);
          },
        },
      ],
    },
    {
      text: '重新加入复用原成员记录（不新增重复成员），位置共享关闭且旧同意不恢复（本轮隐私规则替代旧默认值规则）',
      checks: [
        {
          at: 7,
          desc: '成员记录条数与主键',
          run: async (ctx) => {
            const rows = await ctx.repo.find(C.CREW_MEMBERS, { crewId: 'crew-a' });
            const before = ctx.initial.members.find((m) => m.userId === 'member-c');
            const now = rows.find((m) => m.userId === 'member-c');
            const problems = [];
            if (rows.length !== 3) problems.push(`crew_members 共 ${rows.length} 条（应为 3，不能新增重复成员）`);
            if (!now || !before) problems.push('找不到 member-c 的记录');
            else if (now._id !== before._id) problems.push(`_id 变了：${before._id} → ${now._id}（没有复用原记录）`);
            return problems.length ? fail(problems.join('；')) : pass(`crew_members 仍为 3 条，member-c 复用原记录 ${now._id}`);
          },
        },
        {
          at: 7,
          desc: '重新加入保持关闭，清除旧同意',
          run: async (ctx) => {
            const m = await ctx.repo.findOne(C.CREW_MEMBERS, { crewId: 'crew-a', userId: 'member-c' });
            const crew = await ctx.repo.get(C.CREWS, 'crew-a');
            const problems = [];
            if (m.locationSharing !== false || m.locationConsentPolicyVersion) problems.push('重新加入未经主动同意就恢复共享');
            if (m.leftAt !== null) problems.push(`leftAt=${iso(m.leftAt)}（重新加入应清空）`);
            if (m.status !== 'active') problems.push(`status=${m.status}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass(
                  '重新加入后 locationSharing=false、旧同意已清除、leftAt=null、status=active'
                );
          },
        },
      ],
    },
    {
      text: '退出后移出本轮参与名单并保留退出记录；重新加入不恢复本轮参与资格',
      checks: [
        {
          at: 1,
          desc: '退出之后',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const expected = ctx.initial.meetTask.participants.filter(p => p.userId !== 'member-c');
            return canon(doc.participants) === canon(expected) &&
              (doc.withdrawnParticipants || []).some(p => p.userId === 'member-c')
              ? pass('已退出成员不再阻塞集合，退出前的参与记录保留')
              : fail(`参与或退出记录不正确：${trim(canon(doc.participants))}`);
          },
        },
        {
          at: 9,
          desc: '重新加入之后（第 9 步 meet.get 也复核一次）',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const resp = ctx.data(9).meetTask;
            const problems = [];
            const expected = ctx.initial.meetTask.participants.filter(p => p.userId !== 'member-c');
            if (canon(doc.participants) !== canon(expected)) problems.push('存储层重新加入恢复了旧参与资格');
            if (canon(resp.participants) !== canon(expected)) problems.push('响应重新加入恢复了旧参与资格');
            if (doc.version !== 1) problems.push(`version=${doc.version}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass('重新加入不恢复本轮参与资格，集合版本未变')
          },
        },
      ],
    },
    {
      text: '退出仅重算集合参与人数和状态，不改集合地点时间或原行程',
      checks: [
        {
          at: 1,
          desc: '退出之后的 meet 与 trip',
          run: async (ctx) => {
            const meet = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            const problems = [];
            for (const key of ['version', 'placeId', 'point', 'plannedMeetAt', 'tripId']) {
              if (canon(meet[key]) !== canon(ctx.initial.meetTask[key])) problems.push(`集合 ${key} 被改写`);
            }
            if (canon(trip) !== canon(ctx.initial.trip)) problems.push('行程被改写');
            return problems.length ? fail(problems.join('；')) : pass('退出仅重算集合参与状态，不改地点时间和原行程');
          },
        },
        {
          at: 7,
          desc: '重新加入之后的 meet 与 trip',
          run: async (ctx) => {
            const meet = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            const problems = [];
            for (const key of ['version', 'placeId', 'point', 'plannedMeetAt', 'tripId']) {
              if (canon(meet[key]) !== canon(ctx.initial.meetTask[key])) problems.push(`集合 ${key} 被改写`);
            }
            if (canon(trip) !== canon(ctx.initial.trip)) problems.push('行程被改写');
            return problems.length ? fail(problems.join('；')) : pass('重新加入不恢复旧参与资格，不改地点时间和原行程');
          },
        },
      ],
    },
  ],
  expectedStateChecks: [
    {
      at: 6,
      text: 'expectedState.crew（退出后）：memberCount=2，成员只含 owner-a 与 member-b 且均为 active',
      run: async (ctx) => {
        const active = await ctx.repo.find(C.CREW_MEMBERS, { crewId: 'crew-a', status: 'active' });
        const crew = await ctx.repo.get(C.CREWS, 'crew-a');
        const ids = active.map((m) => m.userId).sort();
        const problems = [];
        if (crew.memberCount !== 2) problems.push(`memberCount=${crew.memberCount}`);
        if (ids.join(',') !== 'member-b,owner-a') problems.push(`active 成员=${JSON.stringify(ids)}`);
        return problems.length ? fail(problems.join('；')) : pass('memberCount=2，active 成员=[member-b, owner-a]');
      },
    },
    {
      at: 8,
      text: 'expectedState.crew（本轮隐私规则）：memberCount=3，member-c 回到名单且 active/role=member/locationSharing=false',
      run: async (ctx) => {
        const crewResp = ctx.data(8); // 第 8 步的 crew.get 响应
        const c = crewResp.members.find((m) => m.userId === 'member-c');
        const problems = [];
        if (crewResp.crew.memberCount !== 3) problems.push(`memberCount=${crewResp.crew.memberCount}`);
        if (!c) problems.push('成员名单里没有 member-c');
        else {
          if (c.role !== 'member') problems.push(`role=${c.role}`);
          if (c.locationSharing !== false) problems.push(`locationSharing=${c.locationSharing}`);
        }
        return problems.length ? fail(problems.join('；')) : pass('memberCount=3，member-c 在名单里（role=member，locationSharing=false）');
      },
    },
    {
      at: 9,
      text: 'expectedState.meetTask：status=confirmed、version=1、participants 排除已退出成员',
      run: async (ctx) => {
        const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
        const problems = [];
        if (doc.status !== 'confirmed') problems.push(`status=${doc.status}`);
        if (doc.version !== 1) problems.push(`version=${doc.version}`);
        const expected = ctx.initial.meetTask.participants.filter(p => p.userId !== 'member-c');
        if (canon(doc.participants) !== canon(expected)) problems.push('participants 未排除已退出成员');
        return problems.length ? fail(problems.join('；')) : pass('status=confirmed version=1，退出者不再计入本轮集合');
      },
    },
  ],
};

// ── replay-021 地图或 AI 失败 ───────────────────────────────────
CASE_SPECS['replay-021'] = {
  usesFailingReplayMap: true,
  observe: {
    1: ['ok', 'reason', 'message', 'legs', 'status', 'mapApiCalls'],
    2: [
      'tripId',
      'feasible',
      'saved',
      'walkTimes.bySource',
      'walkTimes.upstreamFailed',
      'walkTimes.failures[].from',
      'walkTimes.failures[].to',
      'walkTimes.failures[].reason',
      'walkTimes.note',
      'nodes[].travelSource',
      'nodes[].travelMode',
    ],
    3: ['trip.version', 'trip.nodes[].placeId', 'trip.nodes[].travelSource', 'trip.nodes[].plannedStayMin'],
  },
  expect: {
    1: E.fn((res) => {
      if (!res.ok) return fail(`信封层不应该是错误（失败的应是地图那一段）：${res.error.code} ${res.error.message}`);
      const d = res.data;
      const problems = [];
      if (d.ok !== false) problems.push(`data.ok=${d.ok}`);
      if (!d.reason) problems.push('reason 为空');
      if (!d.message) problems.push('message 为空');
      if (!Array.isArray(d.legs) || d.legs.length !== 0) problems.push(`legs=${JSON.stringify(d.legs)}`);
      for (const k of ['distanceMeters', 'durationMinutes', 'route']) {
        if (Object.prototype.hasOwnProperty.call(d, k)) problems.push(`响应里出现了 ${k}（不得给出一条编造的路线）`);
      }
      return problems.length
        ? fail(problems.join('；'))
        : pass(`信封 ok=true，data.ok=false reason=${d.reason} legs=[] message=「${trim(d.message, 120)}」，且没有 distanceMeters/durationMinutes/route`);
    }),
    2: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      const d = res.data;
      const w = d.walkTimes || {};
      const problems = [];
      if (!d.tripId) problems.push('tripId 为空');
      if (!Array.isArray(w.failures) || !w.failures.length) problems.push('walkTimes.failures 为空');
      if (!w.bySource || !Object.prototype.hasOwnProperty.call(w.bySource, 'estimated')) {
        problems.push(`walkTimes.bySource 不含 estimated：${JSON.stringify(w.bySource)}`);
      }
      if (!w.note) problems.push('walkTimes.note 为空');
      return problems.length
        ? fail(problems.join('；'))
        : pass(
            `tripId=${d.tripId} failures=${JSON.stringify(w.failures.map((f) => `${f.from}→${f.to}:${f.reason}`))} ` +
              `bySource=${JSON.stringify(w.bySource)} note=「${trim(w.note, 80)}」`
          );
    }),
    3: E.fn((res) => {
      if (!res.ok) return fail(`期望成功，实际 ${res.error.code}：${res.error.message}`);
      /**
       * ⚠️ `trip.get` 的节点嵌在 `data.trip.nodes` 里（案例的 `nodes[]` 是简写）。
       * 第一版按 `data.nodes` 读，于是"读到 0 个节点"——**读数路径写错会伪装成实现问题**，
       * 所以这里把路径写清楚。
       */
      const nodes = (res.data.trip && res.data.trip.nodes) || [];
      const sources = nodes.map((n) => n.travelSource);
      const problems = [];
      if (!nodes.length) problems.push('新行程没有任何节点');
      for (const s of sources) {
        if (s === 'upstream' || s === 'survey') problems.push(`travelSource=${s}（估算被标成了真实路线/实测）`);
      }
      return problems.length
        ? fail(problems.join('；'))
        : pass(`nodes 共 ${nodes.length} 个，travelSource=[${sources.join(', ')}]（估算可识别）`);
    }),
  },
  probes: [],
  invariants: [
    {
      text: '地图接口失败时 trip.legRoute 的 data.ok 必须为 false 且 legs 为空：不得返回任何 distanceMeters / durationMinutes / route',
      checks: [
        {
          at: 1,
          desc: '第 1 步响应逐字段核对',
          run: async (ctx) => {
            const res = ctx.resp(1);
            const d = res.ok ? res.data : null;
            const problems = [];
            if (!res.ok) problems.push('信封层返回了错误，无法判断"结构化失败"是否成立');
            if (!d) problems.push('没有可读的 data');
            else {
              if (d.ok !== false) problems.push(`data.ok=${d.ok}`);
              if (!Array.isArray(d.legs) || d.legs.length !== 0) problems.push(`legs=${JSON.stringify(d.legs)}`);
              for (const k of ['distanceMeters', 'durationMinutes', 'route']) {
                if (Object.prototype.hasOwnProperty.call(d, k)) problems.push(`出现了 ${k}`);
              }
            }
            return problems.length ? fail(problems.join('；')) : pass('data.ok=false、legs=[]，且没有任何距离/耗时/路径字段');
          },
        },
      ],
    },
    {
      text: '规划中取不到真实路线的路段必须计入 walkTimes.failures，其 travelSource 不得为 upstream / survey（估算必须可识别）',
      checks: [
        {
          at: 2,
          desc: '第 2 步（trip.plan）的 walkTimes.failures',
          run: async (ctx) => {
            const w = ctx.data(2).walkTimes || {};
            const failures = w.failures || [];
            const problems = [];
            if (!failures.length) problems.push('walkTimes.failures 为空（失败被吞掉了）');
            for (const f of failures) {
              if (!f.reason) problems.push(`失败项缺 reason：${JSON.stringify(f)}`);
              if (!f.from || !f.to) problems.push(`失败项缺端点：${JSON.stringify(f)}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`failures=${JSON.stringify(failures.map((f) => `${f.from}→${f.to}(${f.reason})`))}`);
          },
        },
        {
          at: 3,
          desc: '新行程每个节点的 travelSource',
          run: async (ctx) => {
            const nodes = (ctx.data(3).trip && ctx.data(3).trip.nodes) || [];
            const bad = nodes.filter((n) => n.travelSource === 'upstream' || n.travelSource === 'survey');
            if (!nodes.length) return fail('没有节点可检查');
            if (bad.length) {
              return fail(
                `节点 ${JSON.stringify(bad.map((n) => ({ placeId: n.placeId, travelSource: n.travelSource })))} ` +
                  '被标成 upstream/survey —— 取不到真实路线时不得冒充'
              );
            }
            return pass(`nodes[].travelSource=[${nodes.map((n) => n.travelSource).join(', ')}]，没有一段被标成 upstream/survey`);
          },
        },
        {
          /**
           * ⚠️ 这条是 invariant#2 的**严格读法**：不是"failures 非空就行"，
           * 而是"取不到真实路线的**每一段**都必须计入"。起点段也算一段
           * （plan 返回 `startLeg`，第一个节点的 `travelFromStart = true`）。
           *
           * 正是这条断言让 replay-021 停在 blocked（见 CASE_VERDICTS）——
           * 放宽成"非空即可"它就会变绿，而那恰好是指令里禁止做的事。
           */
          at: 2,
          desc: '每一段"取不到真实路线"的行程段都必须出现在 walkTimes.failures 里',
          run: async (ctx) => {
            const d = ctx.data(2);
            const w = d.walkTimes || {};
            const nodes = d.nodes || [];
            const estimated = nodes.filter((n) => n.travelSource === 'estimated');
            const coveredTo = new Set((w.failures || []).map((f) => f.to));
            const missing = estimated.filter((n) => !coveredTo.has(n.placeName));
            const shown =
              `bySource.estimated=${(w.bySource || {}).estimated}、upstreamFailed=${w.upstreamFailed}、` +
              `failures=${(w.failures || []).length} 条、note=「${w.note}」`;
            if (missing.length) {
              return fail(
                `有 ${missing.length} 段回落为直线估算却没有计入 walkTimes.failures：` +
                  `${JSON.stringify(missing.map((n) => ({ placeId: n.placeId, placeName: n.placeName, travelFromStart: n.travelFromStart })))}；` +
                  `而 ${shown} —— 同一响应里"估算段数"与"失败段数"互相矛盾（实现侧漏计，见 finding）`
              );
            }
            return pass(`每段估算都在 failures 里有对应条目；${shown}`);
          },
        },
      ],
    },
    {
      text: '失败不得静默：响应必须带 reason 与 message',
      checks: [
        {
          at: 1,
          desc: '第 1 步的 reason / message',
          run: async (ctx) => {
            const d = ctx.data(1);
            const problems = [];
            if (typeof d.reason !== 'string' || !d.reason) problems.push(`reason=${JSON.stringify(d.reason)}`);
            if (typeof d.message !== 'string' || !d.message) problems.push(`message=${JSON.stringify(d.message)}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass(`reason=${d.reason}，message=「${trim(d.message, 120)}」`);
          },
        },
        {
          at: 2,
          desc: '规划响应的 walkTimes.note 必须说明回落',
          run: async (ctx) => {
            const note = ctx.data(2).walkTimes && ctx.data(2).walkTimes.note;
            return note ? pass(`walkTimes.note=「${trim(note, 100)}」`) : fail('walkTimes.note 为空，回落没有留痕');
          },
        },
      ],
    },
    {
      text: '回放夹具找不到对应录音时必须显式失败，不得静默返回空结果',
      checks: [
        {
          at: 3,
          desc: '注入的回放传输层确实因为"没有录音"而失败',
          run: async (ctx) => {
            const misses = ctx.mapFixture.misses;
            if (!misses.length) return fail('回放传输层一次都没有被调用 —— 这条断言没有被真正验证');
            const kinds = [...new Set(misses.map((m) => m.kind))];
            if (!kinds.includes('direction-walking')) {
              return fail(`没有走 walking 路线接口：${JSON.stringify(kinds)}`);
            }
            const allSayMissing = misses.every((m) => /没有对应的录音/.test(m.message));
            if (!allSayMissing) return fail(`有失败不是因为"没有录音"：${JSON.stringify(misses)}`);
            return pass(
              `回放夹具（recordings: []，strict: true）被调用 ${misses.length} 次，每次都以「没有对应的录音」显式失败：` +
                `kinds=${JSON.stringify(kinds)}`
            );
          },
        },
        {
          at: 1,
          desc: '失败原因如实透出（不是空结果冒充成功）',
          run: async (ctx) => {
            const d = ctx.data(1);
            const problems = [];
            if (d.ok !== false) problems.push('data.ok 不是 false');
            if (!/没有对应的录音/.test(String(d.message || ''))) {
              problems.push(`message 没有说明是缺录音：${d.message}`);
            }
            if (!d.reason) problems.push('reason 为空');
            return problems.length ? fail(problems.join('；')) : pass(`结构性失败如实透出：reason=${d.reason} message 含「没有对应的录音」`);
          },
        },
      ],
    },
    {
      text: '读取导航失败不得改写任何已存在的行程数据',
      checks: [
        {
          at: 1,
          desc: '第 1 步之后既有行程 trip-b',
          run: async (ctx) => ctx.tripUnchanged('读导航失败之后'),
        },
        {
          at: 3,
          desc: '整个案例跑完之后既有行程 trip-b',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-b');
            const problems = [];
            if (trip.version !== 5) problems.push(`version=${trip.version}`);
            if (canon(trip) !== canon(ctx.initial.trip)) problems.push('trip-b 被改写了');
            if (ctx.data(2).tripId === 'trip-b') problems.push('trip.plan 覆盖了既有行程 trip-b（应当新建一条）');
            return problems.length
              ? fail(problems.join('；'))
              : pass(`trip-b 逐字段未变（version=5，nodes ${trip.nodes.length} 个），新计划落在 ${ctx.data(2).tripId}`);
          },
        },
      ],
    },
  ],
  expectedStateChecks: [
    {
      at: 3,
      text: 'expectedState.response.step3：新行程 nodes[].travelSource 只能是 estimated 或 none',
      run: async (ctx) => {
        const nodes = (ctx.data(3).trip && ctx.data(3).trip.nodes) || [];
        const bad = nodes.filter((n) => !['estimated', 'none'].includes(n.travelSource));
        return bad.length
          ? fail(`出现了非估算来源：${JSON.stringify(bad.map((n) => n.travelSource))}`)
          : pass(`travelSource=[${nodes.map((n) => n.travelSource).join(', ')}] 全在 {estimated, none} 内`);
      },
    },
    {
      at: 2,
      text: 'expectedState.response.step2：walkTimes.bySource 含 estimated、failures 非空、note 非空、tripId 非空',
      run: async (ctx) => {
        const d = ctx.data(2);
        const w = d.walkTimes || {};
        const problems = [];
        if (!d.tripId) problems.push('tripId 为空');
        if (!w.bySource || !Object.prototype.hasOwnProperty.call(w.bySource, 'estimated')) problems.push('bySource 不含 estimated');
        if (!Array.isArray(w.failures) || !w.failures.length) problems.push('failures 为空');
        if (!w.note) problems.push('note 为空');
        return problems.length
          ? fail(problems.join('；'))
          : pass(`tripId=${d.tripId} bySource=${JSON.stringify(w.bySource)} failures=${w.failures.length} 段 note 非空`);
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────────
// `mustNotHappen`：绝不允许出现的现象（README §二：**出现即失败**，
// 不论其余断言是否通过）。它与 `invariants` 是两个概念，所以单独成表，
// 再合并回各自的 spec —— 混在一起会让人以为"不变量过了就没事"。
// ─────────────────────────────────────────────────────────────

const MUST_NOT_HAPPEN = {
  'replay-001': [
    {
      text: '把 allArrivedAt 当作出发时间写进线路或 linkToTrip',
      checks: [
        {
          at: 5,
          desc: 'linkToTrip 是否被写入到齐时间',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const problems = [];
            if (canon(doc.linkToTrip) !== canon(ctx.initial.meetTask.linkToTrip)) problems.push('linkToTrip 被改写');
            if (JSON.stringify(doc.linkToTrip || {}).includes('01:05')) problems.push('linkToTrip 里出现了到齐时刻 01:05');
            return problems.length
              ? fail(problems.join('；'))
              : pass('linkToTrip 与夹具逐字段一致，没有被写入到齐时间');
          },
        },
      ],
    },
    {
      text: '到齐后自动重算可行性、改写 trip.nodes 或 plannedEndAt',
      checks: [{ at: 5, desc: '三次到齐之后的行程', run: async (ctx) => ctx.tripUnchanged('三次到齐之后') }],
    },
    {
      text: '用 plannedMeetAt 顶替 allArrivedAt，或反过来用 allArrivedAt 顶替 plannedMeetAt',
      checks: [
        {
          at: 5,
          desc: '① ② 各自保持自己的值',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const problems = [];
            if (iso(doc.plannedMeetAt) !== '2026-10-20T01:00:00.000Z') problems.push(`plannedMeetAt=${iso(doc.plannedMeetAt)}`);
            if (iso(doc.allArrivedAt) !== ctx.clock) {
              problems.push(`allArrivedAt=${iso(doc.allArrivedAt)} ≠ 最后一人到达的服务端时刻 ${ctx.clock}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`①=${iso(doc.plannedMeetAt)}（原值）②=${iso(doc.allArrivedAt)}（服务端时刻），两者未互相顶替`);
          },
        },
      ],
    },
  ],

  'replay-005': [
    {
      text: '把提案自动生效（未经 trip.confirmChange 就改写 trip.nodes）',
      checks: [
        {
          at: 3,
          desc: '确认之前：行程未变 + 提案仍是 proposed',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-b');
            const proposal = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(1).proposal.proposalId);
            const problems = [];
            if (canon(trip) !== canon(ctx.initial.trip)) problems.push('行程被自动改写');
            if (!proposal || proposal.status !== 'proposed') {
              problems.push(`提案 status=${proposal && proposal.status}（还没确认就生效了）`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass('确认之前行程逐字段未变、提案仍是 proposed —— 生效只有 confirmChange 一条路');
          },
        },
      ],
    },
    {
      text: '在 canDepart=false 或缺少 checkId 时写入 departedAt',
      checks: [
        {
          at: 2,
          desc: '第 2 步（缺 checkId）之后',
          run: async (ctx) => {
            const d = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
            return d.departedAt === null ? pass('departedAt 仍为 null') : fail(`departedAt=${iso(d.departedAt)}`);
          },
        },
        {
          at: 1,
          desc: '探针 P3（带 canDepart=false 的 checkId）之后',
          run: async (ctx) => {
            const d = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
            return d.departedAt === null ? pass('被拒之后 departedAt 仍为 null') : fail(`departedAt=${iso(d.departedAt)}`);
          },
        },
      ],
    },
    {
      text: '让成员绕过发起人确认出发',
      checks: [
        {
          at: 0,
          desc: 'member-b 的两次尝试（探针 P1/P2）',
          run: async (ctx) => {
            const problems = [];
            for (const id of ['P1', 'P2']) {
              const p = ctx.probe(id);
              if (p.response.ok) problems.push(`${p.action} 对成员放行`);
              else if (p.response.error.code !== 'FORBIDDEN_NOT_MEMBER') problems.push(`${p.action} 返回 ${p.response.error.code}`);
            }
            return problems.length ? fail(problems.join('；')) : pass('两次尝试都被 FORBIDDEN_NOT_MEMBER 挡住，出发只能由发起人触发');
          },
        },
      ],
    },
    {
      text: '用 allArrivedAt 当作 departedAt（② 与 ③ 混为一谈）',
      checks: [
        {
          at: 6,
          desc: '最终 ② 与 ③',
          run: async (ctx) => {
            const d = await ctx.repo.get(C.MEET_TASKS, 'meet-b');
            const problems = [];
            if (!d.departedAt) problems.push('departedAt 为空');
            else {
              if (iso(d.departedAt) === iso(d.allArrivedAt)) problems.push('③ 与 ② 完全相同');
              if (new Date(d.departedAt) <= new Date(d.allArrivedAt)) problems.push('③ 不晚于 ②');
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(`②=${iso(d.allArrivedAt)} ③=${iso(d.departedAt)} —— 两个独立时刻，相差 ${Math.round(
                  (new Date(d.departedAt) - new Date(d.allArrivedAt)) / 60000
                )} 分钟`);
          },
        },
      ],
    },
  ],

  'replay-009': [
    {
      text: '第二次修改回到第一次之前的版本基线（把已确认的改动丢掉）',
      checks: [
        {
          at: 3,
          desc: '第二次提案的 baseVersion',
          run: async (ctx) => {
            const d = ctx.data(3);
            const problems = [];
            if (d.baseVersion === 3) problems.push('回落到基线 3');
            if (d.baseVersion !== 4) problems.push(`baseVersion=${d.baseVersion}`);
            return problems.length ? fail(problems.join('；')) : pass('第二次提案基于 4（第一次确认后的版本），没有回落到 3');
          },
        },
      ],
    },
    {
      text: '第二次修改静默丢弃 endAt 或 mustVisit 硬约束',
      checks: [
        {
          at: 5,
          desc: '最终 constraints 与夹具逐字段比对',
          run: async (ctx) => {
            const trip = await ctx.repo.get(C.TRIPS, 'trip-a');
            const problems = [];
            if (canon(trip.constraints) !== canon(ctx.initial.trip.constraints)) {
              problems.push(`constraints 与夹具不一致：${trim(canon(trip.constraints))}`);
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass('两次修改之后 constraints 与夹具逐字段一致（endAt / mustVisit 都还在，hardness 与 confirmedAt 未变）');
          },
        },
      ],
    },
    {
      text: '把两次修改合并成一次未经确认的写入',
      checks: [
        {
          at: 4,
          desc: '两次确认各自独立的提案与版本',
          run: async (ctx) => {
            const p1 = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(1).proposalId);
            const p2 = await ctx.repo.get(C.CHANGE_PROPOSALS, ctx.data(3).proposalId);
            const problems = [];
            if (p1._id === p2._id) problems.push('两次修改共用一个提案');
            for (const [label, p] of [['第一次', p1], ['第二次', p2]]) {
              if (p.status !== 'confirmed') problems.push(`${label}提案 status=${p.status}`);
              if (!p.selectedCandidateId) problems.push(`${label}提案没有记录已选候选`);
              if (!Array.isArray(p.confirmations) || !p.confirmations.length) problems.push(`${label}提案没有确认记录`);
            }
            if (ctx.data(2).version !== 4) problems.push(`第一次确认后 version=${ctx.data(2).version}`);
            if (ctx.data(4).version !== 5) problems.push(`第二次确认后 version=${ctx.data(4).version}`);
            return problems.length
              ? fail(problems.join('；'))
              : pass('两个独立提案各自 confirmed、各自有确认记录与已选候选；版本 3 → 4 → 5（没有被合并成一次写入）');
          },
        },
      ],
    },
    {
      text: '用 payload 里的 expectedVersion 代替信封字段',
      checks: [
        {
          at: 5,
          desc: '步骤 payload 不含该键；且缺信封版本时被拒',
          run: async (ctx) => {
            const leaked = ctx.steps
              .filter((s) => s.resolvedPayload && Object.prototype.hasOwnProperty.call(s.resolvedPayload, 'expectedVersion'))
              .map((s) => s.step);
            const problems = [];
            if (leaked.length) problems.push(`第 ${leaked.join('、')} 步把 expectedVersion 写进了 payload`);
            const p1 = ctx.probe('P1');
            if (p1.response.ok) problems.push('缺信封版本时 confirmChange 仍然成功了');
            return problems.length
              ? fail(problems.join('；'))
              : pass('payload 里没有 expectedVersion；缺信封版本时 confirmChange 被拒（校验没有静默失效）');
          },
        },
      ],
    },
  ],

  'replay-013': [
    {
      text: '把旧版本的确认算作有效确认（旧确认不得用于新版本）',
      checks: [
        {
          at: 3,
          desc: '有效确认清单',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const effective = doc.participants.filter((p) => p.status === 'confirmed' && p.confirmedVersion === doc.version);
            const ids = effective.map((p) => p.userId);
            return ids.length === 1 && ids[0] === 'member-b'
              ? pass(`有效确认只有 ${ids.join(',')}（owner-a / member-c 的 version=1 确认没有被算进去）`)
              : fail(`有效确认=${JSON.stringify(ids)}，应为 ['member-b']`);
          },
        },
      ],
    },
    {
      text: '在版本不匹配时静默按当前版本执行',
      checks: [
        {
          at: 2,
          desc: '被拒之后的任务版本',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            const problems = [];
            if (doc.version !== 2) problems.push(`version=${doc.version}`);
            if (doc.revision !== undefined) problems.push(`revision=${doc.revision}（被拒的确认不该推进 revision）`);
            return problems.length ? fail(problems.join('；')) : pass('version 仍为 2、revision 未被写入 —— 没有被"按当前版本执行"');
          },
        },
      ],
    },
    {
      text: '确认被拒后仍写入 confirmedAt 或改变参与者状态',
      checks: [
        {
          at: 2,
          desc: '三名参与者与夹具逐字段比对',
          run: async (ctx) => {
            const doc = await ctx.repo.get(C.MEET_TASKS, 'meet-a');
            return canon(doc.participants) === canon(ctx.initial.meetTask.participants)
              ? pass('participants 与夹具逐字段一致（confirmedVersion / confirmedAt / status 都没被动过）')
              : fail(`participants 被改写：${trim(canon(doc.participants))}`);
          },
        },
      ],
    },
  ],

  'replay-017': [
    {
      text: '退出后仍能读到队伍或位置',
      checks: [
        {
          at: 4,
          desc: '第 2、3 步的响应',
          run: async (ctx) => {
            const problems = [];
            for (const n of [2, 3]) {
              const res = ctx.resp(n);
              if (res.ok) problems.push(`第 ${n} 步（${ctx.step(n).action}）放行了`);
              else if (res.error.code !== 'FORBIDDEN_NOT_MEMBER') problems.push(`第 ${n} 步返回 ${res.error.code}`);
            }
            return problems.length ? fail(problems.join('；')) : pass('crew.get 与 loc.list 都被 FORBIDDEN_NOT_MEMBER 拒绝');
          },
        },
      ],
    },
    {
      text: 'memberCount 不递减（把已退出者算作成员）',
      checks: [
        {
          at: 1,
          desc: '退出之后的 memberCount',
          run: async (ctx) => {
            const crew = await ctx.repo.get(C.CREWS, 'crew-a');
            return crew.memberCount === 2 ? pass('memberCount 由 3 递减到 2') : fail(`memberCount=${crew.memberCount}`);
          },
        },
      ],
    },
    {
      text: '需要额外的「失效」动作才撤销访问',
      checks: [
        {
          at: 4,
          desc: '退出之后的第一个调用就被拒',
          run: async (ctx) => {
            const afterLeave = [2, 3, 4].map((n) => ctx.step(n).action);
            const meta = ctx.resp(2).meta || {};
            const problems = [];
            if (afterLeave[0] !== 'crew.get') problems.push(`退出后的第一个调用是 ${afterLeave[0]}`);
            if (meta.durationMs === undefined) problems.push('缺少 meta.durationMs');
            return problems.length
              ? fail(problems.join('；'))
              : pass(`退出后的调用序列 [${afterLeave.join(' → ')}] 全部立即被拒，期间没有任何"失效/注销"类 action`);
          },
        },
      ],
    },
    {
      text: '重新加入时自动恢复共享或沿用旧同意（本轮隐私规则）',
      checks: [
        {
          at: 7,
          desc: '退出时被置为 false → 重新加入后仍须本人重新开启',
          run: async (ctx) => {
            const crew = await ctx.repo.get(C.CREWS, 'crew-a');
            const afterLeave = ctx.captured('member-c.locationSharing.afterLeave');
            const now = await ctx.repo.findOne(C.CREW_MEMBERS, { crewId: 'crew-a', userId: 'member-c' });
            const want = false;
            const problems = [];
            if (afterLeave !== false) {
              problems.push(`退出时存储层的 locationSharing=${afterLeave}（crew.leave 应当置 false，这条前置条件不成立）`);
            }
            if (now.locationSharing !== want || now.locationConsentPolicyVersion) problems.push('重新加入恢复了共享或旧同意');
            return problems.length
              ? fail(problems.join('；'))
              : pass(
                  '退出和重新加入后共享均为 false，旧同意不恢复'
                );
          },
        },
      ],
    },
  ],

  'replay-021': [
    {
      text: '把直线估算标成 upstream（真实路线）',
      checks: [
        {
          at: 3,
          desc: '新行程每段的 travelSource',
          run: async (ctx) => {
            const nodes = (ctx.data(3).trip && ctx.data(3).trip.nodes) || [];
            const bad = nodes.filter((n) => n.travelSource === 'upstream' || n.travelSource === 'survey');
            return bad.length
              ? fail(`被标成真实路线的段：${JSON.stringify(bad.map((n) => n.placeId))}`)
              : pass(`每段 travelSource=[${nodes.map((n) => n.travelSource).join(', ')}]，估算没有被标成真实路线`);
          },
        },
      ],
    },
    {
      text: '接口失败时返回一条编造的路线或距离',
      checks: [
        {
          at: 1,
          desc: '第 1 步响应里有没有编造出来的数',
          run: async (ctx) => {
            const d = ctx.data(1);
            const problems = [];
            for (const k of ['distanceMeters', 'durationMinutes', 'route']) {
              if (Object.prototype.hasOwnProperty.call(d, k)) problems.push(`出现了 ${k}`);
            }
            if (!Array.isArray(d.legs) || d.legs.length) problems.push(`legs=${JSON.stringify(d.legs)}`);
            return problems.length ? fail(problems.join('；')) : pass('失败时只回 ok=false + legs=[]，没有任何距离/耗时/路径');
          },
        },
      ],
    },
    {
      text: '吞掉失败后给出「看起来可行」的结论而不留痕',
      checks: [
        {
          at: 3,
          desc: '可行结论与留痕是否并存',
          run: async (ctx) => {
            const plan = ctx.data(2);
            const w = plan.walkTimes || {};
            const nodes = (ctx.data(3).trip && ctx.data(3).trip.nodes) || [];
            const estimated = nodes.filter((n) => n.travelSource === 'estimated').length;
            const problems = [];
            if (plan.feasible === true && estimated > 0) {
              if (!w.failures || !w.failures.length) problems.push('给了可行结论却没有留下任何失败记录');
              if (!w.note) problems.push('没有说明来源回落');
            }
            return problems.length
              ? fail(problems.join('；'))
              : pass(
                  `规划 feasible=true 但留了痕：failures ${(w.failures || []).length} 条、note 非空、${estimated} 段标为 estimated` +
                    `（注：留痕的**完整性**由 invariant#2 单独判定）`
                );
          },
        },
      ],
    },
  ],
};

for (const [id, list] of Object.entries(MUST_NOT_HAPPEN)) CASE_SPECS[id].mustNotHappen = list;

// ─────────────────────────────────────────────────────────────
// 额外发现（不在本次 6 条的断言范围内，但**跑的时候看到了**）
// ─────────────────────────────────────────────────────────────
//
// 与 `CASE_VERDICTS` 的区别：那些是"案例的断言与实现冲突"，
// 这些是"案例没断言、但执行过程中观察到的不一致"。
// 后者不改任何案例的状态，但必须如实写下来 —— 否则等于看见了不说。

const ADDITIONAL_FINDINGS = [
  {
    id: 'obs-001',
    seenIn: 'replay-021',
    title: '规划响应的地图调用计数漏计距离矩阵与公交调用',
    symptom:
      'replay-021 的第 2 步（trip.plan）实际发出了 5 次距离矩阵调用 + 1 次步行路线调用 + 1 次公交调用（共 7 次上游请求，' +
      '由注入的回放传输层逐次记录），而响应里 `walkTimes.mapApiCalls = 1`、' +
      'decision 记录里的 `mapApiCalls` 同样是 1。',
    expected:
      '`walkTimes.mapApiCalls` 的自我说明是"本次规划真实消耗的地图接口调用次数（11/8、11/12 成本核算要用）"；' +
      '`resolveLegTravelTimes` 自己的注释也写着"**配额如实计数** —— 结果里的 `calls` 要写进 decision 记录"。' +
      '按这两处口径，应当把矩阵与公交的次数一并计入。',
    location:
      'cloudfunctions/api/actions/trip.js:1141 与 :1161（`mapApiCalls: walkFill.mapApiCalls` —— ' +
      '只含 `fillMissingWalkTimes` 与起点段回落的步行路线调用）；' +
      '`resolveLegTravelTimes` 返回的 `calls.matrix` / `calls.transit`（约 :520、:477）被计算出来后没有合并进去。',
    evidence:
      '2026-10-20T02:10 世界 + 回放夹具（recordings: []）：walkTimes = {bySource:{estimated:2}, upstreamFailed:1, ' +
      'mapApiCalls:1, failures:[防洪纪念塔→圣索菲亚教堂]}；legOptions[0].unavailable 与 legOptions[1].unavailable ' +
      '共列出 5 条 tencent-matrix 失败 + 2 条 amap-transit 失败。',
    impact:
      '只影响成本/配额核算与"这次规划花了多少次调用"的可核对性；不影响行程结果本身。' +
      '本次 6 条案例都没有断言 `mapApiCalls`，所以不改任何案例的状态。',
  },
  {
    id: 'obs-002',
    seenIn: 'replay-005',
    title: '两条提案路径对"已完成的节点"处理不一致（trip.nodes 是否保留 done 节点）',
    symptom:
      'replay-005 第 4 步确认 `meet.prepareDepart` 生成的提案后，trip.nodes 变成 ' +
      '[node-a(status=done), node-b(status=pending, seq=1)] —— **保留了已完成的 node-a**；' +
      '而 replay-009 走 `trip.adjust` 生成的提案，确认后 node-a 被完全移出 trip.nodes。',
    expected:
      '案例集内部对此有明确写法：`replay-012` 的 invariants 是「确认后 trip.nodes **不得包含已 done 的节点**，' +
      '也不得让它以 pending 状态复活」，expectedState 也写「只包含重算后的未完成节点……已 done 的 node-a 不得出现」。' +
      '两条路径必须给出同一个答案，否则同一批次的两条案例无法同时成立。',
    location:
      'cloudfunctions/api/actions/departure.js:69（`nodes: result.history.concat(...)` —— 把历史节点并回候选）；' +
      '对照 cloudfunctions/api/actions/trip.js:1382 与 domain/planner.js:382（`toNodes(evaluation.timeline.legs)` —— ' +
      '候选只含重算后的未完成节点）。',
    evidence:
      'replay-005 确认后存储层：trip.nodes = [{"nodeId":"node-a","status":"done","seq":0},{"nodeId":"node-b","status":"pending","seq":1}]；' +
      'replay-009 确认后存储层：trip.nodes = [node-b, node-c]（node-a 不在其中）。',
    impact:
      '影响"行程里还看不看得到已完成的那一站"，以及 `departure.js` 里按 done 过滤 mustVisit 的既有逻辑。' +
      '本次 6 条案例都没有对"确认后 trip.nodes 的组成"写断言，所以只作为交叉观察记录，不改案例状态。',
  },
];



/** 回放夹具：`recordings: []` + `strict: true` —— 任何一次调用都必须显式失败。 */
function makeFailingReplayMapFixture() {
  const inner = createReplayTransport({ recordings: [], strict: true });
  const misses = [];
  /**
   * ⚠️ 这里把"没有对应的录音"包成 `HttpError`（`code: UPSTREAM_MAP_FAILED`）。
   *
   * 理由：本传输层**就是** `lib/http.js` 那个传输层的位置（`opts.http`），
   * 真实网络失败也长这个样子。若不包装，`lib/map/replay.js` 抛出的是普通 `Error`，
   * `tencent.walkingRoute` 会把它记成 `reason: 'UNKNOWN'` —— 那是案例括号里
   * 没有列举的第四种取值（案例写的是 UPSTREAM_FAILED / UPSTREAM_STATUS_* / THREW 之一）。
   * 按传输层失败建模既符合案例列举、也符合真实失败形态；两种形态的差异记在记录里。
   */
  const transport = async (url, opts) => {
    try {
      return await inner(url, opts);
    } catch (e) {
      misses.push({ kind: kindOfUrl(url), message: (e && e.message) || String(e) });
      throw new HttpError((e && e.message) || String(e), { url: redact(url), replayMissingRecording: true });
    }
  };
  return {
    misses,
    transport,
    factory: (name, opts) =>
      createTencentProvider(Object.assign({}, opts, { http: transport, key: 'REPLAY_KEY', timeoutMs: 1000 })),
  };
}

/**
 * 其它案例的地图工厂：走假 provider（不连外网），但**记下每一次调用**。
 * 本批有 5 条案例本不该碰地图服务 —— 真碰了就应当在记录里看得见。
 */
function makeRecordingFakeMapFactory(bucket) {
  return (name, opts) => {
    bucket.calls += 1;
    bucket.names.push(name || '(默认)');
    return createMapProvider('fake', opts);
  };
}

/** 回放夹具里的公交服务：同样"没有录音"，任何调用都显式失败。 */
function makeFailingReplayTransitProvider() {
  return () => ({
    name: 'replay-transit',
    keyStatus: () => ({ configured: true, masked: 'REPLAY', trimmed: false }),
    route: async () => {
      throw new Error('没有对应的录音：kind=transit（回放夹具里没有公交录音）');
    },
  });
}

async function runCase(caseId) {
  const dataset = loadDataset();
  const caseDef = dataset.json.cases.find((c) => c.caseId === caseId);
  if (!caseDef) throw new ReplayError(`案例集里没有 ${caseId}`);
  const spec = CASE_SPECS[caseId];
  if (!spec) throw new ReplayError(`没有为 ${caseId} 写断言翻译表（拒绝"跑一下看看 ok 就行"）`);

  const clock = caseDef.initialState.clock;
  const mapBucket = { calls: 0, names: [] };
  const mapFixture = spec.usesFailingReplayMap ? makeFailingReplayMapFixture() : null;

  const world = await makeWorld({
    now: clock,
    /** 不铺默认地点夹具：地点一律来自案例自己的 initialState.places */
    seedPlaces: [],
    createMapProvider: mapFixture ? mapFixture.factory : makeRecordingFakeMapFactory(mapBucket),
    createTransitProvider: spec.usesFailingReplayMap ? makeFailingReplayTransitProvider() : null,
    createSpeechProvider: null, createOcrProvider: null, createGuideProvider: null, createInviteProvider: null, createSubscribeProvider: null,
  });

  const { notes: fixtureNotes, crewId } = await injectFixture(world, caseDef);
  const ids = {
    crewId,
    tripId: caseDef.initialState.trip ? caseDef.initialState.trip.tripId : null,
    meetTaskId: caseDef.initialState.meetTask ? caseDef.initialState.meetTask.meetTaskId : null,
  };
  const initial = await snapshotInitial(world, ids);

  const state = {
    world,
    caseDef,
    spec,
    initial,
    responses: {},
    probeResults: {},
    steps: [],
    /** 断言之间传递观测值用（如"退出后存储层是什么"）—— 只在同一条案例内有效 */
    captured: {},
    ids,
    clock,
    snapshotAfterStep: {},
  };

  const ctx = {
    w: world,
    repo: world.repo,
    caseDef,
    spec,
    initial,
    ids,
    clock,
    steps: state.steps,
    step: (n) => state.steps.find((s) => s.step === n) || null,
    resp: (n) => state.responses[String(n)],
    data: (n) => {
      const r = state.responses[String(n)];
      if (!r || !r.ok) throw new ReplayError(`第 ${n} 步没有成功响应，断言无法求值`);
      return r.data;
    },
    probe: (id) => state.probeResults[id],
    snapshotAfterStep: state.snapshotAfterStep,
    /**
     * 断言之间传递观测值：有的断言必须"先看到 A 时刻的值，再和 B 时刻比"
     * （例：退出后存储层 locationSharing=false → 重新加入后应当被重置）。
     * 没有它就只能拿**夹具**的初值与结果比，而那是错的 —— 夹具初值不代表退出时的值。
     */
    capture: (key, value) => {
      state.captured[key] = value;
      return value;
    },
    captured: (key) => state.captured[key],
    mapFixture,
    tripUnchanged: async (label) => {
      const cur = await world.repo.get(C.TRIPS, ids.tripId);
      return canon(cur) === canon(initial.trip)
        ? pass(`${label}：trip 与夹具逐字段一致（version=${cur.version}，nodes ${(cur.nodes || []).length} 个）`)
        : fail(`${label}：trip 被改写了\n  现在 ${trim(canon(cur))}\n  夹具 ${trim(canon(initial.trip))}`);
    },
  };

  const invariantResults = (spec.invariants || []).map((inv) => ({ inv, results: [] }));
  const mustNotResults = (spec.mustNotHappen || []).map((inv) => ({ inv, results: [] }));
  const expectedResults = (spec.expectedStateChecks || []).map((c) => ({ check: c, result: null }));
  const stepRecords = [];
  const probeRecords = [];
  const resolutionErrors = [];

  /** 在某一步之后跑该步挂着的检查 */
  async function runChecksAt(at) {
    for (const bucket of invariantResults.concat(mustNotResults)) {
      for (const check of bucket.inv.checks || []) {
        if (check.at !== at) continue;
        bucket.results.push(Object.assign({ at, desc: check.desc }, await safeRun(check.run, ctx, check.desc)));
      }
    }
    for (const item of expectedResults) {
      if (item.check.at !== at || item.result) continue;
      item.result = Object.assign({ at, desc: item.check.text }, await safeRun(item.check.run, ctx, item.check.text));
    }
  }

  /**
   * 每一步 action **跑完就立刻**存一份行程快照，**在探针之前**。
   * 这样"这一步之后 trip 没有变"一类断言比的是"案例这一步的效果"，
   * 而不是被同一步的探针污染过的状态。
   */
  async function snapshotStep(n) {
    state.snapshotAfterStep[n] = await world.repo.get(C.TRIPS, ids.tripId);
  }

  async function runProbesAt(at) {
    const list = (spec.probes || []).filter((p) => (p.at === undefined ? 0 : p.at) === at);
    for (const probe of list) {
      const record = { id: probe.id, at, why: probe.why, actor: probe.actor, action: probe.action };
      let payload = probe.payload;
      try {
        payload = resolvePayload(probe.payload, state);
      } catch (e) {
        record.ok = false;
        record.errorCode = 'PLACEHOLDER_UNRESOLVED';
        record.observed = { error: e.message };
        record.resolved = false;
        record.verdict = fail(`占位符解析失败：${e.message}`);
        state.probeResults[probe.id] = record;
        probeRecords.push(record);
        resolutionErrors.push(`${probe.id}（${probe.action}）：${e.message}`);
        continue;
      }
      const now = probe.nowFrom
        ? new Date(
            Date.parse(pathGet(state.responses[String(probe.nowFrom.fromStep)].data, probe.nowFrom.path)) +
              (probe.nowFrom.plusMin || 0) * 60000
          ).toISOString()
        : clock;
      record.now = now;
      record.requestId = `${caseId}:probe:${probe.id}`;
      record.resolvedPayload = payload;
      const response = await callActor(world, probe.actor, probe.action, payload, probe.expectedVersion, {
        now,
        requestId: record.requestId,
      });
      record.response = response;
      record.ok = response.ok;
      record.errorCode = response.ok ? null : response.error.code;
      record.observed = pickPaths(response.ok ? response.data : { error: response.error }, probe.observe || defaultObserve(response));
      /** 先登记，后面的 verify 才拿得到本次探针自己的响应（如 P4 要读自己的 now） */
      state.probeResults[probe.id] = record;
      probeRecords.push(record);

      const problems = [];
      if (probe.expectCode) {
        if (response.ok) problems.push(`期望被拒（${probe.expectCode}），实际成功`);
        else if (response.error.code !== probe.expectCode) problems.push(`期望 ${probe.expectCode}，实际 ${response.error.code}`);
      } else if (probe.expectOk && !response.ok) {
        problems.push(`期望成功，实际 ${response.error.code}：${response.error.message}`);
      }
      let verdict = problems.length ? fail(problems.join('；')) : pass(`${probe.action}：${response.ok ? 'ok' : response.error.code}`);
      if (!problems.length && probe.expectOkCheck && response.ok) {
        const extra = await safeRun(() => probe.expectOkCheck(response), ctx, probe.why);
        if (!extra.passed) verdict = extra;
        else verdict = pass(`${verdict.evidence}；${extra.evidence}`);
      }
      if (!problems.length && probe.verify) {
        const extra = await safeRun(() => probe.verify(ctx, response), ctx, probe.why);
        if (!extra.passed) verdict = extra;
        else verdict = pass(`${verdict.evidence}；${extra.evidence}`);
      }
      record.verdict = verdict;
    }
  }

  // 探针可以在第 0 步（任何 action 之前）
  await runProbesAt(0);
  await runChecksAt(0);

  for (const step of caseDef.steps) {
    const n = step.step;
    const record = { step: n, actor: step.actor, action: step.action, note: step.note };
    record.requestId = `${caseId}:step:${n}`;
    record.now = clock;

    let payload;
    try {
      payload = resolvePayload(step.payload, state);
    } catch (e) {
      record.ok = false;
      record.errorCode = 'PLACEHOLDER_UNRESOLVED';
      record.observed = { error: e.message };
      record.expectation = fail(`占位符解析失败：${e.message}`);
      stepRecords.push(record);
      state.steps.push({ step: n, action: step.action, actor: step.actor, expectedVersion: step.expectedVersion, resolvedPayload: null, response: null });
      resolutionErrors.push(`第 ${n} 步（${step.action}）：${e.message}`);
      await snapshotStep(n);
      /**
       * ⚠️ 这一步没跑成，但**挂在这一步上的检查仍要求值** ——
       * 否则一次占位符失败会把后面所有断言悄悄变成"没执行"，
       * 而"没执行"在记录里看起来与"通过"差不多。
       */
      await runProbesAt(n);
      await runChecksAt(n);
      continue;
    }

    record.resolvedPayload = payload;
    record.expectedVersion = step.expectedVersion === undefined ? null : step.expectedVersion;
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'expectedVersion')) {
      record.envelopeLeak = true;
    }

    const response = await callActor(world, step.actor, step.action, payload, step.expectedVersion, {
      now: clock,
      requestId: record.requestId,
    });
    record.response = response;
    record.ok = response.ok;
    record.errorCode = response.ok ? null : response.error.code;
    record.observed = pickPaths(
      response.ok ? response.data : { error: response.error },
      (spec.observe && spec.observe[n]) || defaultObserve(response)
    );

    const check = spec.expect && spec.expect[n];
    record.expectation = check ? await safeRun(() => check(response, ctx), ctx, `第 ${n} 步`) : fail('没有为该步写期望');
    stepRecords.push(record);

    state.responses[String(n)] = response;
    state.steps.push({
      step: n,
      action: step.action,
      actor: step.actor,
      note: step.note,
      expectedVersion: step.expectedVersion,
      resolvedPayload: payload,
      response,
    });
    await snapshotStep(n);

    await runProbesAt(n);
    await runChecksAt(n);
  }

  // 没挂 `at` 的检查：跑完之后统一求值
  for (const bucket of invariantResults.concat(mustNotResults)) {
    for (const check of bucket.inv.checks || []) {
      if (check.at !== undefined) continue;
      bucket.results.push(Object.assign({ at: null, desc: check.desc }, await safeRun(check.run, ctx, check.desc)));
    }
  }

  const aggregate = (bucket) => {
    const passed = bucket.results.length > 0 && bucket.results.every((r) => r.passed);
    return {
      text: bucket.inv.text,
      checkedBy: 'machine',
      passed,
      evidence: bucket.results
        .map((r) => `${r.passed ? '✓' : '✗'}${r.at === null ? '' : ` [第 ${r.at} 步后]`} ${r.desc}：${r.evidence}`)
        .join('\n'),
      checks: bucket.results.length,
    };
  };

  // 汇总 invariants
  const invariants = invariantResults.map(({ inv, results }) => {
    if (inv.manual) {
      return {
        text: inv.text,
        checkedBy: 'manual',
        passed: null,
        evidence: inv.manualEvidence || '',
        machineChecks: (inv.machineChecks || []).map((m) => ({ desc: m.desc, passed: m.passed, evidence: m.evidence })),
      };
    }
    return aggregate({ inv, results });
  });

  /** README §二：mustNotHappen 是"出现即失败"，与 invariants 分开统计。 */
  const mustNotHappenChecks = mustNotResults.map(aggregate);

  const expectedStateChecks = expectedResults.map(({ check, result }) => ({
    text: check.text,
    at: check.at === undefined ? null : check.at,
    checkedBy: 'machine',
    passed: Boolean(result && result.passed),
    evidence: result ? result.evidence : '（该检查没有执行）',
  }));

  const machineInvariants = invariants.filter((i) => i.checkedBy === 'machine');
  const manualInvariants = invariants.filter((i) => i.checkedBy === 'manual');
  const failedMachine = machineInvariants.filter((i) => !i.passed);
  const failedExpected = expectedStateChecks.filter((c) => !c.passed);
  const failedMustNot = mustNotHappenChecks.filter((c) => !c.passed);
  const failedSteps = stepRecords.filter((s) => s.expectation && !s.expectation.passed);
  const failedProbes = probeRecords.filter((p) => p.verdict && !p.verdict.passed);

  const verdict = CASE_VERDICTS[caseId] || null;
  let status;
  if (verdict && verdict.status === 'blocked') status = 'blocked';
  else if (
    resolutionErrors.length ||
    failedSteps.length ||
    failedProbes.length ||
    failedMachine.length ||
    failedExpected.length ||
    failedMustNot.length
  ) {
    status = 'failed';
  } else {
    status = 'passed';
  }

  const caseDefects = CASE_DEFECTS[caseId] || [];
  const finding =
    status === 'blocked'
      ? verdict.finding
      : status === 'failed'
        ? buildFinding({ resolutionErrors, failedSteps, failedProbes, failedMachine, failedExpected, failedMustNot, caseDef })
        : null;

  return {
    caseId,
    category: caseDef.category,
    evidenceLevel: caseDef.evidenceLevel,
    core: caseDef.core === true,
    title: caseDef.title,
    status,
    fixtureInjected: true,
    fixtureNotes,
    environment: {
      repository: 'memory（lib/repo/memory.js，本地内存仓储）',
      invoke: 'cloudfunctions/api/lib/invoke.js（与同一份 actions 代码）',
      clock: clock,
      mapProvider: spec.usesFailingReplayMap
        ? '回放夹具（lib/map/replay.js，recordings: []，strict: true）+ 回放公交（无录音）'
        : `假地图 provider（未连外网）；本案例实际调用地图 ${mapBucket.calls} 次`,
    },
    steps: stepRecords.map((s) => ({
      step: s.step,
      actor: s.actor,
      action: s.action,
      ok: s.ok,
      errorCode: s.errorCode,
      observed: s.observed,
      requestId: s.requestId,
      now: s.now,
      expectedVersion: s.expectedVersion,
      expectationPassed: Boolean(s.expectation && s.expectation.passed),
      expectationEvidence: s.expectation ? s.expectation.evidence : null,
      note: s.note,
    })),
    probes: probeRecords.map((p) => ({
      id: p.id,
      at: p.at,
      why: p.why,
      actor: p.actor,
      action: p.action,
      ok: p.ok,
      errorCode: p.errorCode,
      observed: p.observed,
      requestId: p.requestId,
      now: p.now,
      verdictPassed: Boolean(p.verdict && p.verdict.passed),
      verdictEvidence: p.verdict ? p.verdict.evidence : null,
    })),
    invariants,
    mustNotHappenChecks,
    expectedStateChecks,
    machineInvariants: {
      total: machineInvariants.length,
      passed: machineInvariants.filter((i) => i.passed).length,
      failed: failedMachine.length,
      checks: machineInvariants.reduce((s, i) => s + (i.checks || 0), 0),
    },
    /** mustNotHappen 的机器判定数（README：出现即失败） */
    mustNotHappen: {
      total: mustNotHappenChecks.length,
      passed: mustNotHappenChecks.length - failedMustNot.length,
      failed: failedMustNot.length,
      checks: mustNotHappenChecks.reduce((s, i) => s + (i.checks || 0), 0),
    },
    manualInvariants: {
      total: manualInvariants.length,
      note: '人工项不计入"通过"',
    },
    caseDefects,
    finding,
  };
}

/** 断言函数抛异常时也要留下证据，而不是把整个执行器带崩。 */
async function safeRun(fn, ctx, desc) {
  try {
    const r = await fn(ctx);
    if (!r || typeof r.passed !== 'boolean' || typeof r.evidence !== 'string') {
      return fail(`断言「${desc}」没有返回 {passed, evidence}：${trim(JSON.stringify(r))}`);
    }
    return r;
  } catch (e) {
    return fail(`断言「${desc}」求值异常：${(e && e.message) || String(e)}`);
  }
}

function defaultObserve(res) {
  return res.ok ? ['ok'] : ['error.code', 'error.message'];
}

async function callActor(world, actor, action, payload, expectedVersion, opts) {
  /**
   * ⚠️ **身份怎么对齐**（这一处很容易写错，写错了整条案例都会 FORBIDDEN_NOT_MEMBER）。
   *
   * 案例的 `initialState` 里，人叫 `owner-a` / `member-b` / `member-c`：
   * 它们是 `crew.ownerUserId`、`meetTask.participants[].userId`、`locations[].userId`。
   * 而授权（`lib/authz.js` 的 `requireCrewMember`）按 **openid** 查 `crew_members`。
   *
   * 所以：**案例里的 userId 就是回放世界里的 openid**。
   * `makeWorld` 的 `w.A/B/C` 是 `openid_A/B/C` —— 另一组身份，拿它们调这些夹具
   * 只会得到 FORBIDDEN_NOT_MEMBER（第一次跑就是这么红的）。
   * 这里用 `w.clientFor(actor)`，于是三个客户端**恰好是案例里的三个人**，
   * 且仍是三个互不相同的 openid（`ACTOR_CLIENT` 记录了这个对应关系，
   * 出现案例之外的人名就当场失败，而不是悄悄换个人去调）。
   */
  const slot = ACTOR_CLIENT[actor];
  if (!slot) {
    return {
      ok: false,
      error: { code: 'UNKNOWN_ACTOR', message: `案例里的 actor「${actor}」不在 owner-a / member-b / member-c 之内`, details: null },
      meta: {},
    };
  }
  /**
   * ⚠️ `expectedVersion` 只走**第三个参数**（信封层）。
   * 步骤自己的 `expectedVersion: null` 表示"该 action 的契约不使用信封版本"，
   * 因此显式传 null，而不是把 undefined 塞进 payload。
   */
  return world.clientFor(actor)(action, payload, {
    expectedVersion: expectedVersion === undefined ? null : expectedVersion,
    now: opts.now,
    requestId: opts.requestId,
  });
}

function buildFinding(p) {
  const parts = [];
  if (p.resolutionErrors.length) parts.push(`占位符无法解析：${p.resolutionErrors.join('；')}`);
  for (const s of p.failedSteps) {
    parts.push(`第 ${s.step} 步（${s.action}）：${s.expectation.evidence}`);
  }
  for (const pr of p.failedProbes) {
    parts.push(`探针 ${pr.id}（${pr.action}）：${pr.verdict.evidence}`);
  }
  for (const inv of p.failedMachine) {
    parts.push(`不变量「${inv.text}」未通过：${inv.evidence}`);
  }
  for (const inv of p.failedMustNot || []) {
    parts.push(`绝不允许发生的「${inv.text}」出现了：${inv.evidence}`);
  }
  for (const c of p.failedExpected) {
    parts.push(`预期状态「${c.text}」未通过：${c.evidence}`);
  }
  return {
    kind: 'assertionFailed',
    detail: parts.join('\n'),
    caseId: p.caseDef.caseId,
    note: '断言未通过 ≠ 实现有缺陷：要先判断是哪一边错。认定实现有缺陷时，把裁决写进 CASE_VERDICTS（状态改 blocked 并写清 finding），不要放宽断言。',
  };
}

// ─────────────────────────────────────────────────────────────
// 记录组装
// ─────────────────────────────────────────────────────────────

function summarize(results) {
  const byLevel = {};
  for (const r of results) {
    const lvl = (byLevel[r.evidenceLevel] = byLevel[r.evidenceLevel] || {
      executed: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
    });
    lvl.executed += 1;
    lvl[r.status] += 1;
  }
  return {
    executed: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    byEvidenceLevel: byLevel,
    machineInvariants: {
      total: results.reduce((s, r) => s + r.machineInvariants.total, 0),
      passed: results.reduce((s, r) => s + r.machineInvariants.passed, 0),
      failed: results.reduce((s, r) => s + r.machineInvariants.failed, 0),
      checks: results.reduce((s, r) => s + r.machineInvariants.checks, 0),
    },
    manualInvariants: results.reduce((s, r) => s + r.manualInvariants.total, 0),
    mustNotHappen: {
      total: results.reduce((s, r) => s + r.mustNotHappen.total, 0),
      passed: results.reduce((s, r) => s + r.mustNotHappen.passed, 0),
      failed: results.reduce((s, r) => s + r.mustNotHappen.failed, 0),
      checks: results.reduce((s, r) => s + r.mustNotHappen.checks, 0),
    },
  };
}

function buildRecord(results, opts) {
  opts = opts || {};
  const dataset = loadDataset();
  return {
    kind: 'teamReplayRecord',
    datasetVersion: dataset.json.datasetVersion,
    sourceFile: 'data/team-replay/cases.v1.json',
    sourceSha256: sourceSha256(),
    executedAt: opts.executedAt || new Date().toISOString(),
    evidenceLevelNote: EVIDENCE_LEVEL_NOTE,
    runner: 'test/replay-runner.js',
    environment: {
      repository: 'memory（本地内存仓储）',
      invoke: 'cloudfunctions/api/lib/invoke.js',
      note:
        '与线上同一条 invoke/actions 路径，只有仓储实现不同；初始状态由夹具直接写库（fixtureInjected），' +
        '步骤全部走真实 action',
    },
    cases: results.map((r) => ({
      caseId: r.caseId,
      category: r.category,
      evidenceLevel: r.evidenceLevel,
      status: r.status,
      fixtureInjected: r.fixtureInjected,
      fixtureNotes: r.fixtureNotes,
      environment: r.environment,
      steps: r.steps,
      probes: r.probes,
      invariants: r.invariants,
      mustNotHappenChecks: r.mustNotHappenChecks,
      expectedStateChecks: r.expectedStateChecks,
      machineInvariants: r.machineInvariants,
      mustNotHappen: r.mustNotHappen,
      manualInvariants: r.manualInvariants,
      caseDefects: r.caseDefects,
      finding: r.finding,
    })),
    /** 不在本次 6 条断言范围内、但执行过程中观察到的实现不一致 */
    additionalFindings: ADDITIONAL_FINDINGS,
    summary: summarize(results),
  };
}

async function runTeamReplay(opts) {
  opts = opts || {};
  const caseIds = opts.caseIds || REPLAY_CASE_IDS;
  const results = [];
  for (const id of caseIds) {
    // 串行：每条案例一个独立世界，互不影响，也让失败点一眼可定位
    results.push(await runCase(id));
  }
  return { record: buildRecord(results, opts), results };
}

/** 本地日期戳（YYYY-MM-DD）—— 记录文件名用它。 */
function localDateStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把记录写到 `data/team-replay/records/<YYYY-MM-DD>.json`（目录不存在就创建）。 */
function writeRecord(record, dir) {
  const targetDir = dir || RECORDS_DIR;
  mkdirSync(targetDir, { recursive: true });
  const file = join(targetDir, `${localDateStamp(new Date(record.executedAt))}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = {
  REPLAY_CASE_IDS,
  EVIDENCE_LEVEL_NOTE,
  CASE_VERDICTS,
  RESOLVED_CASE_VERDICTS,
  CASE_DEFECTS,
  CASE_SPECS,
  DATASET_PATH,
  RECORDS_DIR,
  ACTOR_CLIENT,
  runCase,
  runTeamReplay,
  buildRecord,
  writeRecord,
  sourceSha256,
  loadDataset,
  localDateStamp,
  ReplayError,
  // 也导出内部小工具，便于单条排查
  pickPaths,
  pathGet,
  canon,
};
