'use strict';

const MODES = ['walking', 'bicycling', 'driving', 'transit', 'subway'];
const { requestCount } = require('./map/usage');

async function fetchLegRoute({ mode, from, to, makeRoadProvider, makeTransitProvider }) {
  if (!MODES.includes(mode)) return { ok: false, reason: 'MODE_NOT_SUPPORTED', message: '请选择步行、骑行、驾车或公共交通方式', requestCount: 0 };
  if (mode !== 'transit' && mode !== 'subway') {
    const provider = makeRoadProvider();
    const method = { walking: 'walkingRoute', bicycling: 'bicyclingRoute', driving: 'drivingRoute' }[mode];
    if (typeof provider[method] !== 'function') return { ok: false, mode, reason: 'MODE_NOT_SUPPORTED', message: '当前地图服务暂不支持所选方式，请选择其他方式后重试', requestCount: 0, provider: provider.name };
    const result = await provider[method](from, to);
    return Object.assign({}, result, { requestCount: requestCount(result), mode, provider: provider.name });
  }
  const provider = makeTransitProvider();
  const result = await provider.route({ from, to, city: '0451', includeGeometry: true });
  const base = { mode, provider: provider.name, requestCount: requestCount(result) };
  if (!result.ok) return Object.assign({}, result, base);
  const best = mode === 'subway' ? result.bestSubway : result.best;
  if (best && best.route && best.route.unsupported) return Object.assign(base, {
    ok: false, reason: 'UNSUPPORTED_TRANSIT_SEGMENT', message: '这条路线包含暂不支持展示的铁路或出租车接驳，请打开地图查看完整路线',
  });
  const rides = best && (best.steps || []).filter(s => s.kind === 'transit');
  if (!best || !rides.length || (mode === 'subway' && !best.hasSubway) || !Number.isFinite(best.durationMinutes) || !Number.isFinite(best.distanceMeters)) {
    return Object.assign(base, { ok: false, reason: 'NO_TRANSIT_ROUTE', message: mode === 'subway' ? '未找到含地铁的可用路线' : '未找到可用的公共交通路线', hint: '可切换出行方式，或稍后重试。' });
  }
  const steps = [];
  for (const step of best.steps || []) {
    if (step.kind === 'walking') {
      const instructions = step.allInstructions && step.allInstructions.length ? step.allInstructions : [step.instruction || '步行接驳'];
      instructions.forEach(instruction => steps.push({ kind: 'walking', instruction }));
    } else if (step.kind === 'transit') {
      const stops = (step.viaStops || []).map(s => s.name).filter(Boolean);
      const instruction = [step.lineName, step.departureStop && `${step.departureStop} 上车`, step.arrivalStop && `${step.arrivalStop} 下车`, step.viaStationCount != null && `途经 ${step.viaStationCount} 站`].filter(Boolean).join(' · ');
      steps.push(Object.assign({}, step, { instruction, viaStopText: stops.join('、') }));
    } else if (step.kind === 'entrance-exit') {
      if (step.entranceName) {
        const rideIndex = steps.map(s => s.kind).lastIndexOf('transit');
        steps.splice(rideIndex < 0 ? steps.length : rideIndex, 0, { kind: 'entrance', instruction: `进 ${step.entranceName}` });
      }
      if (step.exitName) steps.push({ kind: 'exit', instruction: `出 ${step.exitName}` });
    } else if (step.instruction) steps.push(step);
  }
  const route = Object.assign({ points: [], polylines: [], decoded: false, pointCount: 0, partial: true }, best.route || {}, { steps: steps.map((s, i) => Object.assign({}, s, { seq: i + 1 })) });
  const { durationMinutes, distanceMeters, walkingMeters, costYuan, transferCount, hasSubway, hasBus, lineNames } = best;
  return Object.assign(base, { ok: true, distanceMeters, durationMinutes, route,
    transit: { durationMinutes, walkingMeters, costYuan, transferCount, hasSubway, hasBus, lineNames } });
}

module.exports = { fetchLegRoute, MODES };
