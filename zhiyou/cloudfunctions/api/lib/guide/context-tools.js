'use strict';

const C = require('../repo/collections');
const { assert, CODES, isAppError } = require('../errors');
const { requireCrewMember } = require('../authz');
const { nowMs, MIN } = require('../time');

const changeIntent = text => !/^(怎么|如何).*(修改|调整)/.test(text) &&
  !/(?:不要|不用|不需要|别)(?:帮我)?(?:修改|调整|变更)|只(?:读|查看|查询)/.test(text) &&
  !(/结束时间/.test(text) && !/改|调整|修改|提前|推迟|延后/.test(text)) &&
  /(?:修改|调整).*(?:行程|路线|计划)|(?:行程|路线|计划).*(?:修改|调整|改一下|改一改)|改为|改成|换成|换去|少(?:待|停)|多(?:待|停)|(?:停留|待|停).*分钟|不去|跳过|删掉|保留.*(?:站|地点)|别删|不要删|新增|加一站|改去|改到|再去|提前.*结束|(?:点|时).*前.*结束|(?:[0-9一二三四五六七八九十两]+(?:点|时|:\d{2})).*(?:结束|走完)|结束时间/.test(text);
const tripIntent = text => /下一站|下一个(?:地方|地点)|当前(?:行程|路线)|(?:行程|路线).*(?:状态|安排|进度|几站|结束|几点)|结束时间|还(?:有|剩).*站|现在(?:到|在)哪|现在.*(?:去哪|该去)|接下来(?:去|往)/.test(text);
const meetingStatusIntent = text => /(?:集合|碰头|会合).*(?:多久|多长|时间|几点|状态|进度|到了|到齐|出发|取消|地点|在哪|导航|怎么走)|(?:导航|带我去).*集合|(?:多久|几点|何时|距离|离|还有多少|还有几).*(?:集合|碰头|会合)|谁.*(?:到了|没到)|到齐了吗/.test(text);
function requestedTools(text) {
  const tools = [];
  if (changeIntent(text)) tools.push('propose_trip_change');
  else if (tripIntent(text)) tools.push('read_trip_status');
  if (meetingStatusIntent(text)) tools.push('read_meeting_status');
  return tools;
}
const iso = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const nodeView = node => node ? { name: node.placeName || '未命名地点', status: node.status,
  plannedStayMin: node.plannedStayMin, plannedArriveAt: iso(node.plannedArriveAt), plannedLeaveAt: iso(node.plannedLeaveAt) } : null;
function changeView(data) {
  return { tripId: data.tripId, baseVersion: data.baseVersion, needsClarification: Boolean(data.needsClarification),
    draftId: data.draftId || null, proposalId: data.proposalId || null, noFeasible: Boolean(data.noFeasible), applied: false,
    questions: data.questions || [], interpretation: data.interpretation || null,
    candidates: (data.candidates || []).map(c => ({ candidateId: c.candidateId, strategyLabel: c.strategyLabel,
      feasible: c.feasible, notes: (c.notes || []).map(n => n.message), conflicts: (c.conflicts || []).map(n => n.message),
      endAt: iso(c.impact && c.impact.changedEndAt),
      nodes: (c.nodes || []).map(nodeView) })) };
}

// IDs come from the authenticated request / crew record, never from model tool arguments.
async function selectTrip(ctx, state, input, reads) {
  let id = input.tripId;
  if (input.scope === 'team' || !id) {
    if (state.crewId) {
      await requireCrewMember(ctx.repo, state.crewId, ctx.openid);
      const crew = await ctx.repo.get(C.CREWS, state.crewId);
      id = crew.activeTripId || null;
      reads.crew = { id: crew._id, activeTripId: id };
    } else id = null;
  }
  if (!id) return null;
  const trip = await require('../../actions/trip').loadTripForRead(ctx.repo, id, ctx.openid);
  assert(trip.mode !== 'team' || trip.crewId === state.crewId, CODES.FORBIDDEN_NOT_MEMBER, '行程所属队伍已变化，请重新打开助手');
  reads.trip = { id: trip._id, version: trip.version, mode: trip.mode, crewId: trip.crewId || null };
  return trip;
}

async function executeContextTool(ctx, state, input, tool, reads) {
  const serverTime = new Date(nowMs(ctx)).toISOString();
  if (tool === 'read_meeting_status') {
    if (!state.crewId) return { answer: '尚未加入队伍，无法查询集合。请先在“我的”加入队伍。', meetingContext: { serverTime, available: false } };
    await requireCrewMember(ctx.repo, state.crewId, ctx.openid);
    const tasks = await ctx.repo.find(C.MEET_TASKS, { crewId: state.crewId }, { sort: { createdAt: -1 }, limit: 1 });
    const task = tasks[0];
    if (!task) return { answer: '当前队伍还没有集合任务。可在队伍页选择地点和时间后手动发起。', meetingContext: { serverTime, available: false } };
    reads.meeting = { id: task._id, version: task.version, revision: task.revision || 0 };
    const participants = task.participants || [];
    const confirmed = participants.filter(p => ['confirmed', 'arrived'].includes(p.status) && p.confirmedVersion === task.version);
    const planned = iso(task.plannedMeetAt), delta = planned ? new Date(planned).getTime() - nowMs(ctx) : null;
    const terminal = ['cancelled', 'departed', 'completed'].includes(task.status);
    const meetingContext = { available: true, serverTime, status: task.status, version: task.version,
      name: task.placeName || '未命名集合点', plannedMeetAt: planned, allArrivedAt: iso(task.allArrivedAt), departedAt: iso(task.departedAt),
      remainingMinutes: !terminal && delta !== null && delta > 0 ? Math.ceil(delta / MIN) : null,
      overdueMinutes: !terminal && delta !== null && delta < 0 ? Math.ceil(-delta / MIN) : null,
      confirmedCount: confirmed.length, arrivedCount: confirmed.filter(p => p.status === 'arrived').length, participantCount: participants.length };
    let answer = '当前集合点：' + meetingContext.name + '。';
    if (task.status === 'cancelled') answer += '本次集合已取消。';
    else if (task.status === 'departed') answer += '本次集合已出发。';
    else if (task.status === 'completed') answer += '本次集合已结束。';
    else {
      if (meetingContext.remainingMinutes !== null) answer += '距离计划集合时间还有约' + meetingContext.remainingMinutes + '分钟。';
      else if (meetingContext.overdueMinutes !== null) answer += '计划集合时间已过约' + meetingContext.overdueMinutes + '分钟。';
      else answer += planned ? '已到计划集合时间。' : '尚未设置有效的计划集合时间。';
      answer += '本版本已确认' + meetingContext.confirmedCount + '/' + participants.length + '人，已标记到达' + meetingContext.arrivedCount + '人。';
      if (task.allArrivedAt) answer += '系统已有实际到齐记录。';
      answer += '计划时间不代表实际到齐或出发。';
    }
    if (!terminal && /导航|怎么走|带我去/.test(input.text)) answer += '点击“导航到集合点”打开地图并选择路线。';
    return { answer, meetingContext };
  }
  const trip = await selectTrip(ctx, state, input, reads);
  if (!trip) return { answer: input.scope === 'team' ? '当前队伍尚未发布共同路线，请先在队伍中发布路线。' : '还没有当前行程，请先在行程页生成路线，或在队伍中发布共同路线。',
    tripContext: { available: false, serverTime } };
  const member = trip.mode === 'team' ? await requireCrewMember(ctx.repo, trip.crewId, ctx.openid) : null;
  const nodes = (trip.nodes || []).slice().sort((a, b) => a.seq - b.seq);
  const current = nodes.find(n => n.status === 'arrived'), next = nodes.find(n => n.status === 'pending');
  const tripContext = { available: true, serverTime, tripId: trip._id, title: trip.title || (trip.mode === 'team' ? '队伍共同路线' : '当前行程'),
    mode: trip.mode, version: trip.version, status: trip.status, canModify: member ? member.role === 'owner' : trip.ownerUserId === ctx.openid,
    current: nodeView(current), next: trip.status === 'active' ? nodeView(next) : null,
    remainingCount: nodes.filter(n => ['arrived', 'pending'].includes(n.status)).length, plannedEndAt: iso(trip.plannedEndAt) };
  if (tool === 'read_trip_status') {
    let answer = '正在查看“' + tripContext.title + '”（第' + trip.version + '版）。';
    if (trip.status !== 'active') answer += '该行程当前不是可执行状态，请先在行程页确认。';
    else {
      if (current) answer += '你已标记到达：' + tripContext.current.name + '。';
      if (next) answer += '下一站是“' + tripContext.next.name + '”，计划停留' + next.plannedStayMin + '分钟。';
      else answer += current ? '这是最后一个未完成站点，后面没有待前往的站点。' : '所有站点均已完成或跳过，没有下一站。';
      answer += '剩余未完成站点' + tripContext.remainingCount + '个。';
      if (tripContext.plannedEndAt) {
        const end = new Date(new Date(tripContext.plannedEndAt).getTime() + 8 * 60 * MIN);
        answer += '计划结束于' + (end.getUTCMonth() + 1) + '月' + end.getUTCDate() + '日' +
          String(end.getUTCHours()).padStart(2, '0') + ':' + String(end.getUTCMinutes()).padStart(2, '0') + '（北京时间）。';
      }
    }
    if (tripContext.next && /导航|怎么走|带我去/.test(input.text)) answer += '点击“导航到下一站”打开地图并选择路线。';
    return { answer, tripContext };
  }
  if (!tripContext.canModify) return { tripContext, answer: '你可以查看共同路线，但只有队伍发起人可以修改。请让发起人提交修改要求。' };
  if (trip.status !== 'active') return { tripContext, answer: '该行程当前不是可执行状态，请先在行程页检查后再修改。' };
  // Only the user's own explicit request can create a proposal. Models cannot supply edits or auto-confirm.
  assert(changeIntent(input.text), CODES.INVALID_PARAM, '请明确说明想怎样修改行程');
  try {
    const response = await require('../../actions/trip-text').adjustText({ ...ctx, action: 'trip.adjustText', expectedVersion: trip.version,
      payload: { tripId: trip._id, text: input.text } });
    const tripChange = changeView({ ...response.data, tripId: trip._id });
    return { tripContext, tripChange, answer: tripChange.needsClarification ? '需要先补充下面的修改要求，原行程尚未改变。'
      : tripChange.noFeasible ? '当前要求下没有可行的调整方案，原行程未改变。请调整条件后重新提交。'
        : '已生成行程修改方案，请查看地点、停留时间和取舍，选择方案并确认后才会生效。' };
  } catch (e) {
    if (!isAppError(e)) throw e;
    return { tripContext, answer: '没有执行修改：' + e.message };
  }
}

async function validateContextReads(tx, reads, openid) {
  if (reads.crew) {
    const crew = await tx.get(C.CREWS, reads.crew.id);
    assert(crew && crew.status === 'active' && (crew.activeTripId || null) === reads.crew.activeTripId,
      CODES.VERSION_CONFLICT, '队伍当前路线已变化，请重新提问');
  }
  if (reads.trip) {
    const trip = await tx.get(C.TRIPS, reads.trip.id);
    assert(trip && trip.version === reads.trip.version && trip.mode === reads.trip.mode &&
      (trip.mode === 'team' ? trip.crewId === reads.trip.crewId : trip.ownerUserId === openid),
    CODES.VERSION_CONFLICT, '行程已更新或访问权限已变化，请重新提问');
  }
  if (reads.meeting) {
    const task = await tx.get(C.MEET_TASKS, reads.meeting.id);
    assert(task && task.version === reads.meeting.version && (task.revision || 0) === reads.meeting.revision,
      CODES.VERSION_CONFLICT, '集合状态已变化，请重新提问');
  }
}
module.exports = { requestedTools, changeIntent, tripIntent, meetingStatusIntent, executeContextTool, validateContextReads, selectTrip };
