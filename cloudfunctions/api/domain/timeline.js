'use strict';

/**
 * 时间线推算 —— §6.3：
 *   预计完成时间 = 当前时间 + 剩余交通时间 + 停留时间 + 必要的集合及衔接时间
 *
 * 本模块是纯函数：不读数据库、不看当前时间（除传入的 startAt），因此可被完整单测。
 */

const { addMin, diffMin } = require('../lib/time');
const geo = require('../lib/geo');

/**
 * @param {object} p
 * @param {Date}   p.startAt      出发时刻
 * @param {Array}  p.items        [{nodeId?, placeId, stayMin?}]，stayMin 省略则用地点默认值
 * @param {object} p.placesById   placeId -> place
 * @param {object} p.params       {walkSpeedMPerMin, stayMinDefault, meetBufferMin}
 * @returns {{legs:Array, endAt:Date, totalWalkMin:number, totalWalkMeters:number, totalStayMin:number, meetBufferMin:number}}
 */
function buildTimeline(p) {
  const params = p.params || {};
  const stayDefault = params.stayMinDefault || 30;
  const meetBufferMin = params.meetBufferMin || 0;

  const legs = [];
  let cursor = new Date(p.startAt);
  let totalWalkMin = 0;
  let totalWalkMeters = 0;
  let totalStayMin = 0;
  /**
   * 非步行方式的耗时合计 —— **不能并进 `totalWalkMin`**。
   *
   * `maxWalkMinutes` 是硬约束（用户说"少走点路"）。把车程算成步行会让
   * 这个约束失效：30 分钟公交被记成"走了 30 分钟"，于是"没超上限"。
   */
  let totalRideMin = 0;
  let prevPlace = null;

  /**
   * 真实出行耗时覆盖 —— `{ [toPlaceId]: { minutes, meters, mode, source, provider, reason } }`。
   *
   * ── 为什么要这个参数（2026-10-14）────────────────────────
   *
   * 在此之前，每段的耗时只能来自 `geo.walkMinutes`（踏勘缓存或直线估算）。
   * 而用户要的是"显示真实出行方式"——哈尔滨的景点跨区，步行根本走不通：
   *
   *   中央大街 → 冰雪大世界   地铁 69.5 分 / 126 路 63.1 分 / **步行估算 不等于可步行**
   *
   * 调用方（`leg-times`）会先把各方式的**真实耗时**取回来并选一种，
   * 结果从这里传进来。**这个函数保持同步纯函数** —— 取数的事在外面做完，
   * 时间线的推算依然是可测的纯逻辑。
   */
  const overrides = p.legTimes || {};

  (p.items || []).forEach((item, idx) => {
    const place = p.placesById[item.placeId];
    if (!place) return; // 调用方应已校验；此处跳过而非编造数据

    let travelMin = 0;
    let travelMeters = 0;
    let travelSource = 'none';
    let travelFromStart = false;
    let travelMode = 'none';
    /** 选这一段的理由与来源，供界面直接展示（§6.5「改得清楚」） */
    let travelReason = null;
    let travelProvider = null;

    /** 有真实覆盖就用它 —— **优先级高于缓存与估算** */
    const ov = overrides[item.placeId];

    if (idx === 0) {
      if (ov && typeof ov.minutes === 'number') {
        travelMin = ov.minutes;
        travelMeters = ov.meters || 0;
        travelSource = ov.source || 'upstream';
        travelMode = ov.mode || 'walking';
        travelReason = ov.reason || null;
        travelProvider = ov.provider || null;
        travelFromStart = true;
      } else if (p.startLeg && typeof p.startLeg.minutes === 'number') {
        /**
         * 第一段：从**出发位置**（通常是"我的位置"）到第一站。
         *
         * 不这样算的话，行程会假装人已经在第一个景点门口 ——
         * 计划出发时间、总步行量与"能不能赶上结束时间"都会偏乐观。
         */
        travelMin = p.startLeg.minutes;
        travelMeters = p.startLeg.meters || 0;
        travelSource = p.startLeg.source || 'estimated';
        travelMode = p.startLeg.mode || 'walking';
        travelFromStart = true;
      }
    } else if (ov && typeof ov.minutes === 'number') {
      travelMin = ov.minutes;
      travelMeters = ov.meters || 0;
      travelSource = ov.source || 'upstream';
      travelMode = ov.mode || 'walking';
      travelReason = ov.reason || null;
      travelProvider = ov.provider || null;
    } else if (prevPlace) {
      const w = geo.walkMinutes(prevPlace, place, params);
      if (w) {
        travelMin = w.minutes;
        travelMeters = w.meters || 0;
        travelSource = w.source;
        travelMode = 'walking';
      }
    }

    const stayMin =
      typeof item.stayMin === 'number'
        ? item.stayMin
        : place.visitDurationMin && typeof place.visitDurationMin.default === 'number'
          ? place.visitDurationMin.default
          : stayDefault;

    const arriveAt = addMin(cursor, travelMin);
    const leaveAt = addMin(arriveAt, stayMin);

    legs.push({
      nodeId: item.nodeId || null,
      seq: idx,
      placeId: place._id,
      placeName: place.name,
      /** 坐标下发到客户端 —— 地图上画游览顺序连线要用 */
      location: place.location || null,
      entranceLocation: place.entranceLocation || null,
      /** 该地点是否经过实地核验：界面要能区分可信与待核验 */
      verified: Boolean(place.verifiedAt) && place.confidence !== 'low',
      /**
       * ── 地点快照（2026-10-13 新增）──────────────────────────
       *
       * ⚠️ **检索到的地点不再入库**（用户决定：全从腾讯地图实时搜），
       * 于是 `adjust` 事后回库按 `placeId` 读是读不到的。
       * 快照让行程**自带它依赖的地点数据**。
       *
       * 与"行程自带约束快照"是同一个原则（见 docs/01）：
       * `adjust` 不依赖原始需求，11/5 的固定测试集要能完整复现。
       * **自洽的记录才可复现。**
       */
      placeSnapshot: {
        _id: place._id,
        name: place.name,
        category: place.category || null,
        location: place.location || null,
        entranceLocation: place.entranceLocation || null,
        visitDurationMin: place.visitDurationMin || null,
        verifiedAt: place.verifiedAt || null,
        confidence: place.confidence || null,
        /** 踏勘实测的步行时间 —— 只有已核验地点才有 */
        walkableTo: place.walkableTo || [],
      },
      travelFromPrevMin: travelMin,
      travelFromPrevMeters: travelMeters,
      travelSource,
      /**
       * 这一段的出行方式。2026-10-14 起是**真的**了 ——
       * 之前这里被写死成 `'walking'`（注释还写着"首版只有步行；字段预留"），
       * 所以界面上无论怎么走都显示"步行"。
       */
      travelMode,
      /** 选这个方式的理由（`mode-choice` 给的，可直接展示） */
      travelReason,
      /** 这个数是哪家给的（tencent-matrix / amap-transit / cache / estimate） */
      travelProvider,
      /** 该段是否从"出发位置"（我的位置）算起 */
      travelFromStart,
      plannedArriveAt: arriveAt,
      plannedStayMin: stayMin,
      plannedLeaveAt: leaveAt,
    });

    /**
     * ⚠️ 累计字段的含义要分清（2026-10-14）：
     *
     * `totalWalkMin` 原来把**所有段**都加进来，因为那时只有步行。
     * 现在有了驾车/公交，把它们算进"步行分钟"会让
     * `maxWalkMinutes` 这个**硬约束**彻底失真 —— 用户写"少走点路"，
     * 系统却把半小时车程也算成走路，于是判断"没超上限"。
     *
     * 所以：**只有 walking 计入步行量**，其余方式单独累计。
     */
    if (travelMode === 'walking' || travelMode === 'none') {
      totalWalkMin += travelMin;
      totalWalkMeters += travelMeters;
    } else {
      totalRideMin += travelMin;
    }
    totalStayMin += stayMin;
    cursor = leaveAt;
    prevPlace = place;
  });

  // 集合及衔接缓冲：只在末尾加一次，避免每个节点都膨胀
  const endAt = addMin(cursor, meetBufferMin);

  return {
    legs,
    endAt,
    totalWalkMin,
    totalWalkMeters,
    /** 非步行方式的耗时合计（驾车/公交/骑行） */
    totalRideMin,
    totalStayMin,
    meetBufferMin,
  };
}

/** 把时间线转成 trips.nodes 结构。 */
function toNodes(legs, source) {
  return legs.map((l) => ({
    nodeId: l.nodeId || `n_${l.seq}_${l.placeId}`,
    placeId: l.placeId,
    placeName: l.placeName,
    seq: l.seq,
    /** 坐标：客户端据此在地图上画出游览顺序 */
    location: l.location || null,
    entranceLocation: l.entranceLocation || null,
    verified: l.verified === true,
    /** 地点快照 —— 见 legs.push 处的说明（行程自洽，adjust 不回库读） */
    placeSnapshot: l.placeSnapshot || null,
    plannedArriveAt: l.plannedArriveAt,
    plannedLeaveAt: l.plannedLeaveAt,
    plannedStayMin: l.plannedStayMin,
    travelFromPrevMin: l.travelFromPrevMin,
    travelFromPrevMeters: l.travelFromPrevMeters,
    /** 这段出行时间的来源（survey / upstream / estimated）—— 界面必须能区分 */
    travelSource: l.travelSource || 'none',
    /**
     * 出行方式 —— 2026-10-14 起是**真的**了。
     * 之前这里写死 `'walking'`（注释还写着"首版恒为 walking；字段预留"），
     * 所以界面上无论怎么走都显示"步行"。
     */
    travelMode: l.travelMode || 'none',
    /** 选这个方式的理由（`mode-choice` 给的，可直接展示给用户） */
    travelReason: l.travelReason || null,
    /** 这个数是哪家给的（tencent-matrix / amap-transit / cache / estimate） */
    travelProvider: l.travelProvider || null,
    travelFromStart: l.travelFromStart === true,
    status: 'pending',
    actualArriveAt: null,
    actualLeaveAt: null,
    source: source || 'plan',
  }));
}

/** 加总步行分钟。用于 maxWalkMinutes 硬约束检查。 */
const walkMinutesOf = (legs) => legs.reduce((s, l) => s + (l.travelFromPrevMin || 0), 0);

/** 剩余路段（从某节点开始的后续安排）。首版每次只重点处理未来 1–3 个节点（§十）。 */
function remainingFrom(legs, nodeId) {
  const i = legs.findIndex((l) => l.nodeId === nodeId);
  return i < 0 ? legs.slice() : legs.slice(i);
}

/** 两时刻之间的分钟差，用于计算集合延迟对后续的影响。 */
const delayMin = (actual, planned) => Math.max(0, Math.round(diffMin(actual, planned)));

module.exports = { buildTimeline, toNodes, walkMinutesOf, remainingFrom, delayMin };
