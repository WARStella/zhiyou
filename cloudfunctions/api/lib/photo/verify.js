'use strict';

/**
 * 照片正确性核验。
 *
 * ── 这一层解决的是什么问题（2026-10-14 澄清）──────────────
 *
 * 此前把两件事混成了一件，这里必须分开：
 *
 *   ① **地点的物理属性**：可达性、入口在哪、能不能久留 —— 要人到现场（§7.1）。
 *   ② **这张照片是不是这个地点** —— **可以远程核验**，而且比"到现场再照一张"更客观：
 *      现场照只证明"拍照者当时在那儿"，核验不了"这张网图是否张冠李戴"。
 *
 * 这一层只做 ②。它不声称任何关于地点物理属性的事 ——
 * 那种声称必须来自实地踏勘，见 `lib/authz.js` 的 `verificationLevel`。
 *
 * ── 为什么值得单独做一层 ──────────────────────────────────
 *
 * 因为它**可复现、可批量、可留证据**：给定一组地点与一组照片，
 * 同一套检查跑两次得到同一个结论。这正是计划书 §11.3 对一等交付物的要求
 * ——「每条可复现、跑过才算完成」，并直接构成官方材料 e 项的测试记录。
 *
 * 反过来，如果只把照片抓回来直接显示，就得到一句无法回答的追问：
 * **"你怎么知道这张图是对的？"** —— 这一层就是那个答案。
 *
 * ── 四条检查，全部可自动跑 ────────────────────────────────
 *
 *   `poi-identity`   照片所属 POI 与该地点**同名**（宽松比对，允许后缀差异）
 *   `poi-distance`   照片所属 POI 与该地点坐标的距离 ≤ 阈值（默认 300 米）
 *   `photo-source`   照片带可追溯的来源（provider）与标题，不是裸链接
 *   `photo-unique`   同一地点内没有重复图片 URL
 *
 * 未通过的检查**不阻止照片入库**，但照片会带 `photoVerification.passed: false`
 * 与逐条原因。界面默认只展示通过的 —— §6.6「检索到资料 ≠ 资料可信」。
 */

const { judgeTrust, MAX_TRUSTED_DISTANCE_M } = require('./shared');

/** 检查项定义 —— 名字与含义对外只在这里定义一处，界面与文档都引用它 */
const CHECKS = {
  POI_IDENTITY: 'poi-identity',
  POI_DISTANCE: 'poi-distance',
  PHOTO_SOURCE: 'photo-source',
  PHOTO_UNIQUE: 'photo-unique',
};

const CHECK_LABEL = {
  'poi-identity': '照片所属地点与目标地点同名',
  'poi-distance': '照片所属地点在目标点位可信距离内',
  'photo-source': '照片带可追溯来源',
  'photo-unique': '同一地点内无重复图片',
};

/**
 * 核验一组照片。
 *
 * @param {object} input
 * @param {string} input.placeName          目标地点名
 * @param {object} [input.placeLocation]    目标地点坐标
 * @param {Array}  input.photos             待核验照片（provider 的输出）
 * @param {object} [input.matchedPoi]       上游命中的 POI（含 location）
 * @param {number} [input.maxDistanceMeters]
 * @returns {{passed: boolean, checks: Array, reason: string|null, maxDistanceMeters: number}}
 */
function verifyPhotos(input) {
  input = input || {};
  const photos = Array.isArray(input.photos) ? input.photos : [];
  const maxDistanceMeters = input.maxDistanceMeters || MAX_TRUSTED_DISTANCE_M;
  const placeName = input.placeName ? String(input.placeName).trim() : null;
  const placeLocation = input.placeLocation || null;
  const matchedPoi = input.matchedPoi || null;
  const poiLocation = (matchedPoi && matchedPoi.location) || null;

  const checks = [];

  // ① 名字 —— 照片所属 POI 是不是这个地点
  const identity = judgeTrust({
    targetLocation: placeLocation,
    poiLocation,
    expectedName: placeName,
    poiName: matchedPoi ? matchedPoi.name : null,
  });
  checks.push({
    name: CHECKS.POI_IDENTITY,
    label: CHECK_LABEL[CHECKS.POI_IDENTITY],
    /**
     * `name-mismatch` 才算名字这一项不通过；
     * 而 `distance-unknown`（上游没给坐标）不代表名字不对，交给 ② 去说。
     */
    passed: identity.basis !== 'name-mismatch',
    detail: identity.basis === 'name-mismatch' ? identity.detail : `命中「${matchedPoi ? matchedPoi.name : '—'}」`,
  });

  // ② 距离 —— 位置对不上，名字对也不算数
  const distanceOk = identity.basis === 'distance-verified';
  checks.push({
    name: CHECKS.POI_DISTANCE,
    label: CHECK_LABEL[CHECKS.POI_DISTANCE],
    passed: distanceOk,
    distanceMeters: identity.distanceMeters,
    maxDistanceMeters,
    detail: identity.detail,
  });

  // ③ 来源可追溯 —— 答辩要能说清图从哪来
  const sourceOk = photos.length > 0 && photos.every((ph) => Boolean(ph.provider));
  checks.push({
    name: CHECKS.PHOTO_SOURCE,
    label: CHECK_LABEL[CHECKS.PHOTO_SOURCE],
    passed: sourceOk,
    detail: sourceOk
      ? `全部带 provider（${[...new Set(photos.map((p) => p.provider))].join(', ')}）`
      : '有照片缺 provider，无法追溯来源',
  });

  // ④ 去重 —— 同一地点内重复图是抓取异常的信号
  const urls = photos.map((ph) => ph.url).filter(Boolean);
  const uniqueOk = urls.length === new Set(urls).size;
  checks.push({
    name: CHECKS.PHOTO_UNIQUE,
    label: CHECK_LABEL[CHECKS.PHOTO_UNIQUE],
    passed: uniqueOk,
    detail: uniqueOk ? `${urls.length} 张，无重复` : '存在重复图片 URL',
  });

  const failed = checks.filter((c) => !c.passed);
  return {
    /** 全部通过才为 true —— 任何一项存疑都不该展示成"已核验的照片" */
    passed: photos.length > 0 && failed.length === 0,
    checks,
    reason: photos.length === 0 ? 'NO_PHOTOS' : failed.length ? failed.map((c) => c.name).join('+') : null,
    maxDistanceMeters,
  };
}

module.exports = { verifyPhotos, CHECKS, CHECK_LABEL };
