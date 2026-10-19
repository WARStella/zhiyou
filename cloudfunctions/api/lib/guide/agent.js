'use strict';

const crypto = require('crypto');
const { createMapProvider } = require('../map');
const { createOcrProvider } = require('../ocr/tencent');
const { coord, haversineMeters } = require('../geo');
const { requestCount } = require('../map/usage');
const { retrieve, DOCUMENTS, KNOWLEDGE_VERSION } = require('./knowledge');
const { requestedTools, executeContextTool, selectTrip } = require('./context-tools');
const { planningDestination } = require('./plan-intent');

const tools = ['search_places', 'retrieve_knowledge', 'prepare_meeting', 'read_trip_status', 'read_meeting_status', 'propose_trip_change', 'finish'];
const meetingIntent = text => /集合|碰头|会合/.test(text);
const dynamicIntent = text => /票价|门票|营业|开放时间|几点|实时|今天.*开/.test(text);
const clean = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
function keyword(text, clues) {
  const destination = planningDestination(text);
  if (destination) return destination;
  const known = DOCUMENTS.flatMap(doc => doc.names).sort((a, b) => b.length - a.length).find(name => text.includes(name));
  if (known) return known;
  if (clues && clues.length) return clues[0];
  const name = text.replace(/^(请|帮我|能不能|我想|我在|介绍一下|介绍|讲讲|识别一下|识别)+/g, '')
    .replace(/(有什么.*|的历史.*|的故事.*|介绍一下.*|是什么.*|怎么样.*|在哪里.*|在哪.*|集合.*|[？?！!。].*)$/, '').trim();
  return /大学|学院|公园|街|景区|博物馆|教堂|广场|车站|南门|北门|商场/.test(name) && name.length >= 2 && name.length <= 40 ? name : '';
}
function fallbackDecision(state, input, done) {
  if (input.initialPlan) return !state.place || !state.place.name.includes(input.planDestination)
    ? { tool: done.has('search_places') ? 'finish' : 'search_places', query: input.planDestination } : { tool: 'finish' };
  const contextTools = !input.image && requestedTools(input.text);
  if (contextTools && contextTools.length) return { tool: contextTools.find(tool => !done.has(tool)) || 'finish' };
  const name = keyword(input.text, input.clues);
  if (name && (!state.place || !state.place.name.includes(name)) && !done.has('search_places')) return { tool: 'search_places', query: name };
  if (!state.place) return { tool: 'finish' };
  if (!dynamicIntent(input.text) && !done.has('retrieve_knowledge') && !/^(好|谢谢|知道了)[。！!]*$/.test(input.text)) return { tool: 'retrieve_knowledge' };
  if (meetingIntent(input.text) && !done.has('prepare_meeting')) return { tool: 'prepare_meeting' };
  return { tool: 'finish' };
}

async function searchPlaces(ctx, query, center) {
  let result;
  try { result = await (ctx.createMapProvider || createMapProvider)().searchPlaces({ keyword: query, ...(center ? { center, radius: 10000, autoExtend: false } : { region: '哈尔滨' }), pageSize: 10, pageIndex: 1 }); }
  catch (_) { return { candidates: [], calls: 1, status: 'failed' }; }
  if (!result || !result.ok) return { candidates: [], calls: requestCount(result), status: 'failed' };
  const seen = new Set(), candidates = [];
  for (const item of result.items || []) {
    const point = coord(item && item.location), name = clean(item && item.title);
    if (!point || !name || (center && haversineMeters(center, point) > 10000)) continue;
    const key = name + JSON.stringify(point);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ id: crypto.randomBytes(8).toString('hex'), name, address: clean(item.address), point,
      distanceMeters: center ? Math.round(haversineMeters(center, point)) : null,
      evidence: '地图按“' + query + '”检索到的候选，请核对名称、地址和位置后确认' });
  }
  return { candidates: candidates.slice(0, 8), calls: requestCount(result), status: candidates.length ? 'ok' : 'empty' };
}

async function runAgent(ctx, state, input, provider) {
  const trace = [], notices = [], done = new Set();
  let mapApiCalls = 0, chunks = [], meetingDraft = null, searchStatus = null;
  const contextReads = {}, contextAnswers = [], contextResult = {};
  const planDestination = !input.image && planningDestination(input.text);
  if (planDestination) {
    const trip = await selectTrip(ctx, state, input, contextReads);
    input.initialPlan = !trip || trip.status !== 'active';
    input.planDestination = planDestination;
  }
  const deadline = Date.now() + 45000;
  input.clues = [];
  if (input.image) {
    state.place = null; state.candidates = [];
    let vision;
    if (provider.visionAvailable) vision = await provider.identify(input.image.bytes.toString('base64'), input.image.mime);
    if (vision && vision.ok && Array.isArray(vision.data.names)) {
      input.clues = vision.data.names.map(clean).filter(name => name.length >= 2 && name.length <= 60).slice(0, 3);
      trace.push({ tool: 'identify_image', status: input.clues.length ? 'ok' : 'uncertain', mode: 'vision' });
      notices.push('图像结果是地点线索，需用真实地图候选人工确认。');
    } else {
      try {
        const ocr = await (ctx.createOcrProvider || createOcrProvider)().recognize(input.image.bytes, ctx.now);
        const lines = (ocr.lines || []).map(row => clean(row.text)).filter(text => text.length >= 2 && text.length <= 60);
        input.clues = lines.filter(text => /街|门|口|岛|公园|学院|大学|教堂|博物馆/.test(text)).slice(0, 3);
        trace.push({ tool: 'identify_image', status: input.clues.length ? 'ok' : 'uncertain', mode: 'ocr' });
        notices.push('本次使用 OCR 文字辅助识别；视觉模型未配置或暂不可用，没有确定拍摄地点。');
      } catch (_) {
        trace.push({ tool: 'identify_image', status: 'unavailable', mode: 'none' });
        notices.push('照片识别暂不可用，请输入地点名称。视觉模型与 OCR 均未提供可靠线索。');
      }
    }
  }
  // 已执行的工具限制、防止无界循环，工具参数由服务端校验。
  for (let step = 0; step < 3 && Date.now() < deadline; step++) {
    const baseline = fallbackDecision(state, input, done);
    const requested = !input.image && !input.initialPlan && requestedTools(input.text) || [];
    if (requested.length && baseline.tool === 'finish') break;
    let decision = baseline;
    if (!input.initialPlan && provider.modelAvailable && deadline - Date.now() > 9000) {
      const planned = await provider.decide({ question: input.text, imageClues: input.clues,
        confirmedPlace: state.place ? { name: state.place.name, address: state.place.address } : null,
        availableContext: { scope: input.scope || 'trip', hasTripSelection: Boolean(input.tripId), hasCrew: Boolean(state.crewId) },
        history: state.messages.slice(-4), completedTools: Array.from(done),
        observations: trace, retrieved: chunks.map(chunk => ({ chunkId: chunk.chunkId, text: chunk.text })) });
      if (planned && planned.ok && tools.includes(planned.data.tool)) {
        decision = planned.data;
      } else notices.push('智能分析暂不可用，已改用基础规则处理地点线索。');
    } else notices.push(input.initialPlan ? '首次规划按你明确的目的地检索，确认前不会创建行程。' : requested.length ? '本次按明确问题读取业务数据或准备提案，未由模型编造状态。' : '本次使用基础规则处理地点线索，识别范围有限。');
    // Explicit status/change questions cannot be redirected into POI search by the model.
    if (requested.length && !requested.includes(decision.tool) && decision.tool !== 'finish') decision = baseline;
    if (['read_trip_status', 'read_meeting_status', 'propose_trip_change'].includes(decision.tool) && !requested.includes(decision.tool)) decision = baseline;
    if (done.has(decision.tool)) decision = baseline;
    if (decision.tool === 'finish') {
      // 多意图问题不能因过早 finish 丢掉明确的集合请求或未确认地点。
      if (baseline.tool !== 'finish') decision = baseline; else break;
    }
    if (decision.tool === 'search_places' && state.place && state.place.name.includes(clean(decision.query))) decision = baseline;
    if (decision.tool === 'finish') break;
    if (['read_trip_status', 'read_meeting_status', 'propose_trip_change'].includes(decision.tool)) {
      const result = await executeContextTool(ctx, state, input, decision.tool, contextReads);
      contextAnswers.push(result.answer);
      for (const key of ['tripContext', 'meetingContext', 'tripChange']) if (result[key]) contextResult[key] = result[key];
      trace.push({ tool: decision.tool, status: result.tripChange ? 'ready' : 'ok' });
      done.add(decision.tool);
      continue;
    }
    if (decision.tool === 'retrieve_knowledge' && dynamicIntent(input.text)) decision = baseline;
    if (decision.tool === 'finish') break;
    if (decision.tool === 'search_places') {
      const query = clean(decision.query);
      if (done.has('search_places') || query.length < 2 || query.length > 60 || /[<>:/\\]/.test(query)) { notices.push('地点检索词不明确，请补充完整名称。'); break; }
      const result = await searchPlaces(ctx, query, input.initialPlan ? null : input.center);
      state.place = null; state.candidates = result.candidates; state.pendingQuestion = input.text;
      state.clues = input.clues;
      searchStatus = result.status; mapApiCalls += result.calls;
      trace.push({ tool: 'search_places', status: result.status, count: result.candidates.length });
      done.add('search_places');
      break; // 所有地图候选均需用户确认后才可检索讲解或行动。
    }
    if (!state.place) { notices.push('请先选择并确认一个真实地点。'); break; }
    if (decision.tool === 'retrieve_knowledge') {
      chunks = retrieve(state.place, input.text);
      trace.push({ tool: 'retrieve_knowledge', status: chunks.length ? 'ok' : 'empty', count: chunks.length });
    } else if (decision.tool === 'prepare_meeting') {
      if (state.crewId) meetingDraft = { name: state.place.name, address: state.place.address,
        point: state.place.point, crewId: state.crewId, action: 'select_meeting_point' };
      else notices.push('先在“我的”中加入队伍，之后可把确认的地点选作集合点。');
      trace.push({ tool: 'prepare_meeting', status: meetingDraft ? 'ready' : 'needs_team' });
    }
    done.add(decision.tool);
  }
  let paragraphs = chunks.map(chunk => ({ text: chunk.text, chunkId: chunk.chunkId }));
  if (chunks.length && provider.modelAvailable && deadline - Date.now() > 9000) {
    const selected = await provider.selectEvidence({ question: input.text, place: state.place.name,
      chunks: chunks.map(({ chunkId, text }) => ({ chunkId, text })) });
    if (selected && selected.ok && Array.isArray(selected.data.segments)) {
      const validated = selected.data.segments.slice(0, 3).map(segment => {
        const chunk = chunks.find(row => row.chunkId === segment.chunkId);
        return chunk && typeof segment.quote === 'string' && segment.quote.length >= 8 && chunk.text.includes(segment.quote)
          ? { text: segment.quote, chunkId: chunk.chunkId } : null;
      }).filter(Boolean);
      if (validated.length) paragraphs = validated;
      else notices.push('模型片段未通过来源核验，已使用检索到的原资料摘要。');
    } else notices.push('模型讲解暂不可用，已展示有来源的资料摘要。');
  }
  const used = new Set(paragraphs.map(row => row.chunkId));
  const sources = [...new Map(chunks.filter(chunk => used.has(chunk.chunkId)).map(chunk => [chunk.source.id, chunk.source])).values()].map((row, i) => ({ ...row, number: i + 1 }));
  const evidence = paragraphs.map(row => {
    const sourceId = chunks.find(chunk => chunk.chunkId === row.chunkId).source.id;
    return { ...row, sourceId, sourceNumber: sources.find(source => source.id === sourceId).number };
  });
  let answer;
  if (state.candidates.length && !state.place) answer = '找到以下可能的地点。请核对名称、地址和位置，再确认你指的是哪一个；我还没有确定照片拍摄地点。';
  else if (searchStatus === 'failed') answer = '地图检索暂时失败，请稍后重试，或到队伍页手动选点。';
  else if (searchStatus === 'empty') answer = '没有找到匹配的地点。请补充完整地名、修改照片中的错字，或手动选点；我不会补造坐标。';
  else if (!state.place) answer = input.image ? '暂时无法确定照片中的地点。请补充路牌、地标全名或更清晰的照片。' : '请告诉我具体地点名称，或拍一张地标、站牌、入口牌照片。我会先请你确认地点，再讲解或辅助集合。';
  else if (dynamicIntent(input.text)) answer = '已确认“' + state.place.name + '”。当前知识库未接入实时票价、营业时间或当日开放状态，请在景区官方渠道核对；我不会用历史资料推断今天的情况。';
  else if (evidence.length) answer = '关于“' + state.place.name + '”，下面是从已核对资料检索出的讲解片段，可继续追问历史、建筑或景区特色。';
  else if (done.has('retrieve_knowledge')) answer = '已确认“' + state.place.name + '”，但当前知识库没有这个地点的可靠资料，暂时无法提供有来源的讲解。首版资料覆盖中央大街、索菲亚教堂、太阳岛。';
  else answer = '已确认“' + state.place.name + '”。可以继续询问历史、建筑、景区特色，或请我准备集合选点。';
  if (meetingDraft) answer += '\n已准备集合选点建议。点击“用作集合点”并确认后进入队伍页，仍需设置时间并手动发起集合。';
  if (contextAnswers.length) answer = contextAnswers.join('\n');
  const tripPlan = input.initialPlan && state.place && !state.candidates.length ? {
    destination: { name: state.place.name, address: state.place.address, point: state.place.point }, stayMin: 60,
  } : null;
  if (input.initialPlan) {
    if (tripPlan) {
      answer = '已确认目的地“' + state.place.name + '”。请设置出发位置，检查停留时间和出行方式，再点击“确认生成行程”。确认后会生成个人行程并打开行程页。';
      trace.push({ tool: 'prepare_trip_plan', status: 'ready' });
    } else if (state.candidates.length) answer = '先确认你想去的具体地点，随后设置出发位置并生成行程。';
  }
  return { answer, evidence, sources, meetingDraft, tripPlan, candidates: state.candidates, place: state.place,
    ...contextResult, contextReads,
    clues: state.clues || input.clues, trace: trace.map(row => ({ ...row,
      label: { identify_image: '识别照片线索', search_places: '查找真实地点', retrieve_knowledge: '检索景点资料', prepare_meeting: '准备集合选点',
        read_trip_status: '读取当前行程', read_meeting_status: '读取集合状态', propose_trip_change: '生成行程修改提案', prepare_trip_plan: '准备首次游览行程' }[row.tool],
      statusLabel: { ok: '完成', uncertain: '待补充线索', unavailable: '暂不可用', failed: '查询失败', empty: '没有匹配结果', ready: '等待用户确认', needs_team: '需要加入队伍' }[row.status],
    })), notices: [...new Set(notices)], knowledgeVersion: KNOWLEDGE_VERSION,
    mapApiCalls, promptVersion: provider.promptVersion || 'guide-agent-v1' };
}

module.exports = { runAgent, fallbackDecision, keyword, meetingIntent, dynamicIntent };
