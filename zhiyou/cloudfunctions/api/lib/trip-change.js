'use strict';

const time = require('./time');
const { insertNode } = require('./trip-node-insertion');
const compact = s => String(s || '').replace(/[\s「」“”"'的]/g, '').replace(/^(?:在|把|去|到)/, '');
const activeNodes = trip => (trip.nodes || []).filter(n => ['pending', 'arrived'].includes(n.status)).sort((a, b) => a.seq - b.seq);

function resolveNode(target, trip, lastTargetNodeId) {
  const nodes = activeNodes(trip), all = (trip.nodes || []).slice().sort((a, b) => a.seq - b.seq);
  const name = compact(target);
  if (!name || /^(?:再|继续|刚才|刚才那个|刚才那里|那里|上一个地方)$/.test(name)) {
    return lastTargetNodeId ? nodes.filter(n => n.nodeId === lastTargetNodeId)
      : !name && nodes.length === 1 ? nodes : nodes.filter(n => n.status === 'arrived');
  }
  if (/^(?:这里|这儿|当前站|当前这一站|这站|本站|现在这个地方|当前地点)$/.test(name)) return nodes.filter(n => n.status === 'arrived');
  if (/^(?:最后一站|最后一个地方|最后一个地点|末站|最后那个)(?:了)?$/.test(name)) return nodes.slice(-1);
  if (/^(?:下一站|下一个地方)$/.test(name)) return nodes.filter(n => n.status === 'pending').slice(0, 1);
  if (/^(?:第一站|首站)$/.test(name)) return nodes.filter(n => n.nodeId === (all[0] || {}).nodeId);
  const ordinal = name.match(/^第([\d一二三四五六七八九十]+)(?:站|个地方)$/);
  if (ordinal) {
    const idx = require('./ai/trip-change').number(ordinal[1]) - 1;
    return nodes.filter(n => n.nodeId === (all[idx] || {}).nodeId);
  }
  const exact = nodes.filter(n => compact(n.placeName) === name);
  if (exact.length) return exact;
  return name.length >= 2 ? nodes.filter(n => compact(n.placeName).includes(name) || name.includes(compact(n.placeName))) : [];
}

function buildContext(trip, previousOps, changePlaces) {
  const nodes = (trip.nodes || []).map(n => Object.assign({}, n));
  for (const op of previousOps || []) {
    if (op.type === 'skip_remaining') {
      for (const n of nodes) if (op.payload.nodeIds.includes(n.nodeId) && n.status === 'pending') n.status = 'skipped';
      continue;
    }
    if (op.type === 'add_node') {
      const place = (changePlaces || {})[op.payload.newPlaceId];
      if (place) insertNode(nodes, { nodeId: op.payload.nodeId, placeId: place._id, placeName: place.name,
        status: 'pending', plannedStayMin: (place.visitDurationMin || {}).default || (trip.params || {}).stayMinDefault || 30 }, op.payload);
      nodes.forEach((node, seq) => { node.seq = seq; });
      continue;
    }
    const n = nodes.find(n => n.nodeId === op.payload.nodeId);
    if (!n) continue;
    if (op.type === 'extend_stay') n.plannedStayMin += op.payload.deltaMin;
    if (op.type === 'shorten_stay') n.plannedStayMin -= op.payload.deltaMin;
    if (op.type === 'set_stay') n.plannedStayMin = op.payload.stayMin;
    if (op.type === 'skip_node') n.status = 'skipped';
    if (op.type === 'replace_node') {
      const place = (changePlaces || {})[op.payload.newPlaceId];
      if (place) {
        n.placeId = place._id; n.placeName = place.name;
        n.plannedStayMin = (place.visitDurationMin || {}).default || (trip.params || {}).stayMinDefault || 30;
      }
    }
  }
  const last = (previousOps || []).slice().reverse().find(op => /stay/.test(op.type) || ['replace_node', 'add_node'].includes(op.type)) ||
    (previousOps || []).slice().reverse().find(op => op.payload.nodeId);
  return { version: trip.version, plannedStartAt: trip.plannedStartAt, plannedEndAt: trip.plannedEndAt,
    lastTargetNodeId: last ? last.payload.nodeId : (trip.changeContext || {}).lastTargetNodeId || null,
    constraints: (trip.constraints || []).map(c => ({ key: c.key, value: c.value, hardness: c.hardness,
      confirmed: Boolean(c.confirmedAt) })),
    nodes: nodes.map(n => ({ nodeId: n.nodeId, placeName: n.placeName, seq: n.seq,
      status: n.status, plannedStayMin: n.plannedStayMin, placeId: n.placeId })) };
}

function resolve(parsed, context, answers, now, userId, destinationChoices) {
  const operations = [], questions = [], summary = [];
  const input = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  let lastTargetNodeId = context.lastTargetNodeId;
  const question = (key, kind, prompt, options) => questions.push({ key, kind, prompt, options: options || [] });
  const choosePlace = (op, i, prompt, replacingId) => {
    const search = (destinationChoices || {})[i] || { places: [] };
    const place = search.places.find(x => x._id === input[i + '.place']);
    if (!place) {
      if (!search.places.length) question(i + '.place', 'rewrite', search.message || `没有搜到可用的“${op.destination}”，请补充具体地点或校区后重新提交。`);
      else question(i + '.place', 'place', prompt, search.places.map(x => ({ value: x._id,
        label: x.name + (x.address ? ' · ' + x.address : '') })));
      return null;
    }
    return place;
  };
  (parsed.uncertainties || []).forEach((message, i) => question('rewrite-' + i, 'rewrite', message));
  for (let i = 0; i < (parsed.operations || []).length; i++) {
    const op = parsed.operations[i], payload = { sourceMemberIds: [userId], confirmedAt: now };
    if (op.type === 'skip_remaining') {
      const remaining = activeNodes(context).filter(n => n.status === 'pending');
      if (!remaining.length) {
        question(i + '.node', 'rewrite', '当前已经没有尚未到达的站点可取消，已到达和已完成的记录会保留。');
        continue;
      }
      payload.nodeIds = remaining.map(n => n.nodeId);
      remaining.forEach(n => { n.status = 'skipped'; });
      operations.push({ type: op.type, payload });
      summary.push(`取消所有尚未到达的站点（${remaining.length} 站）：${remaining.map(n => n.placeName).join('、')}`);
      continue;
    }
    if (op.type === 'change_end_time') {
      const clock = input[i + '.clock'] || op.clock;
      if (typeof clock !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) {
        question(i + '.clock', 'clock', '请明确结束时间（北京时间，24 小时制）'); continue;
      }
      const date = new Date(new Date(now).getTime() + 8 * time.HOUR).toISOString().slice(0, 10);
      const endAt = new Date(`${date}T${clock}:00+08:00`);
      if (endAt <= new Date(now) || endAt <= new Date(context.plannedStartAt)) {
        question(i + '.clock', 'clock', '请选择今天晚于当前时间及计划出发时间的结束时间'); continue;
      }
      payload.endAt = endAt.toISOString();
      operations.push({ type: op.type, payload }); summary.push('今天 ' + clock + ' 前结束'); continue;
    }
    if (op.type === 'add_node') {
      let anchor = null;
      if (op.position === 'after') {
        const anchors = context.nodes.filter(n => n.status !== 'skipped');
        const chosen = input[i + '.node'];
        // 已完成站只用作位置参照，不参与重算或改写历史。
        const matches = chosen ? anchors.filter(n => n.nodeId === chosen) : resolveNode(op.target, {
          nodes: context.nodes.map(n => n.status === 'done' ? Object.assign({}, n, { status: 'pending' }) : n),
        }, lastTargetNodeId).map(n => anchors.find(a => a.nodeId === n.nodeId)).filter(Boolean);
        if (matches.length !== 1) {
          question(i + '.node', 'node', `要在“${op.target || '哪一站'}”之后新增地点？请选择参照站。`,
            anchors.map(n => ({ value: n.nodeId, label: n.placeName + (n.status === 'done' ? '（已完成）' : '') })));
          break; // 先确定新增节点，再理解后续“这里/再少停”，避免指向旧站。
        }
        anchor = matches[0];
      }
      const place = choosePlace(op, i, `新增哪个“${op.destination}”？请核对校区和地址。`);
      if (!place) break;
      payload.nodeId = op.newNodeId; payload.newPlaceId = place._id;
      payload.insertion = !anchor ? 'end' : anchor.status === 'done' ? 'start' : 'after';
      payload.afterNodeId = payload.insertion === 'after' ? anchor.nodeId : null;
      const stay = (place.visitDurationMin || {}).default || 30;
      insertNode(context.nodes, { nodeId: payload.nodeId, placeId: place._id, placeName: place.name,
        status: 'pending', plannedStayMin: stay }, payload);
      context.nodes.forEach((n, seq) => { n.seq = seq; });
      summary.push(`${anchor ? `在“${anchor.placeName}”之后` : '在行程末尾'}新增“${place.name}”（默认停留 ${stay} 分钟，可继续修改）` +
        (anchor && anchor.status === 'done' ? '；原站已完成，新地点放在剩余行程最前面' : ''));
      operations.push({ type: op.type, payload }); lastTargetNodeId = payload.nodeId;
      continue;
    }
    const nodes = activeNodes(context);
    const chosenId = input[i + '.node'];
    if (op.type === 'replace_node' && !op.target && !nodes.some(n => n.status === 'pending')) {
      question(i + '.node', 'rewrite', '当前没有待前往的站点可替换；如需继续行程，请改为新增地点。');
      continue;
    }
    const matches = chosenId ? nodes.filter(n => n.nodeId === chosenId && ['pending', 'arrived'].includes(n.status))
      : op.type === 'replace_node' && !op.target ? nodes.filter(n => n.status === 'pending').slice(0, 1)
      : op.type === 'change_travel_mode' && !op.target ? nodes.filter(n => n.status === 'pending').slice(0, 1)
      : resolveNode(op.target, context, lastTargetNodeId);
    if (matches.length !== 1) {
      question(i + '.node', 'node', `“${op.target || '刚才那个地方'}”指哪一站？已完成/已跳过的站点不能修改。`,
        (matches.length ? matches : activeNodes(context)).map(n => ({ value: n.nodeId, label: `第 ${n.seq + 1} 站 · ${n.placeName}（${n.plannedStayMin} 分钟）` })));
      continue;
    }
    const n = matches[0]; payload.nodeId = n.nodeId; payload.placeId = n.placeId;
    if (op.type === 'change_travel_mode') {
      if (n.status !== 'pending') {
        question(i + '.node', 'node', '已到达站点的交通保留实际进度，请选择要前往的待游览站点。',
          nodes.filter(x => x.status === 'pending').map(x => ({ value: x.nodeId, label: x.placeName })));
        continue;
      }
      payload.mode = op.mode;
      summary.push(`前往“${n.placeName}”改为${require('./mode-choice').MODE_OPTIONS.find(o => o.value === op.mode).label}`);
    } else if (op.type === 'replace_node') {
      if (n.status === 'arrived') {
        question(i + '.node', 'node', '已到达的地点保留实际进度，请选择要替换的待游览站点。',
          activeNodes(context).filter(x => x.status === 'pending').map(x => ({ value: x.nodeId, label: x.placeName })));
        continue;
      }
      const place = choosePlace(op, i, `将“${n.placeName}”替换为哪个“${op.destination}”？请核对校区和地址。`, n.nodeId);
      if (!place) continue;
      payload.newPlaceId = place._id;
      summary.push(`将“${n.placeName}”替换为“${place.name}”（默认停留 ${(place.visitDurationMin || {}).default || 30} 分钟，可继续修改）`);
      n.placeId = place._id; n.placeName = place.name;
      n.plannedStayMin = (place.visitDurationMin || {}).default || 30;
    } else if (/stay$/.test(op.type)) {
      const amount = input[i + '.minutes'] !== undefined ? Number(input[i + '.minutes']) : op.minutes;
      if (!Number.isInteger(amount) || amount <= 0 || amount > 1440 ||
        (op.type === 'shorten_stay' && amount >= n.plannedStayMin)) {
        question(i + '.minutes', 'minutes', op.type === 'shorten_stay'
          ? `“${n.placeName}”少停多少分钟？须小于当前 ${n.plannedStayMin} 分钟；不去请改写为“跳过”。`
          : `请填写“${n.placeName}”${op.type === 'set_stay' ? '总共停留' : '增加停留'}的分钟数（1—1440）`); continue;
      }
      if (op.type === 'set_stay') { payload.stayMin = amount; n.plannedStayMin = amount; }
      else { payload.deltaMin = amount; n.plannedStayMin += op.type === 'extend_stay' ? amount : -amount; }
      summary.push(`“${n.placeName}”${op.type === 'extend_stay' ? '多停' : op.type === 'shorten_stay' ? '少停' : '总共停留'} ${amount} 分钟`);
    } else {
      summary.push((op.type === 'skip_node' ? '跳过' : '保留') + `“${n.placeName}”`);
      if (op.type === 'skip_node') n.status = 'skipped';
    }
    operations.push({ type: op.type, payload });
    lastTargetNodeId = n.nodeId;
  }
  if (!operations.length && !questions.length) question('rewrite', 'rewrite', '请说明要修改哪一站、停留时间或结束时间');
  return { operations, questions, summary };
}

module.exports = { resolveNode, buildContext, resolve, activeNodes };
