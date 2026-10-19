'use strict';

// 人工核对的短摘要，不含票价、开放时间、入口坐标或网络整页复制。
const KNOWLEDGE_VERSION = 'harbin-guide-20261017-v1';
const DOCUMENTS = [
  { id: 'central-street', names: ['中央大街', '中央大街步行街', '哈尔滨中央大街'], title: '中央大街的旋律',
    publisher: '哈尔滨日报', url: 'https://harbin.joyhua.cn/hebrb/20240828/mhtml/page_07_content_20240828008001.htm',
    publishedAt: '2024-08-28', reviewedAt: '2026-10-17',
    chunks: [
      { topic: '历史沿革', text: '中央大街始建于1898年，早期名为“中国大街”。其发展与近代哈尔滨的商贸活动和城市形成相联系。' },
      { topic: '建筑看点', text: '沿街曾兴建洋行、商铺、餐厅、电影院、音乐厅和住宅。游览时可以从街道两侧建筑观察当时商业与文化生活留下的痕迹。' },
    ] },
  { id: 'saint-sophia', names: ['圣索菲亚教堂', '索菲亚教堂', '哈尔滨圣索菲亚教堂', '哈尔滨市建筑艺术馆'],
    title: '圣·索菲亚教堂—哈尔滨建筑艺术馆', publisher: '哈尔滨文化旅游投资集团',
    url: 'https://www.ciighrb.com/jtweb/web/culturedetail.do?id=5', publishedAt: null, reviewedAt: '2026-10-17',
    chunks: [
      { topic: '历史沿革', text: '圣索菲亚教堂始建于1907年3月，最初是随军教堂，早期为木结构。其历史与近代哈尔滨城市发展有关。' },
      { topic: '建筑与文化', text: '介绍资料将圣索菲亚教堂列为拜占庭风格建筑。哈尔滨市建筑艺术馆于1997年成立，建立在教堂综合整治基础上，展示和宣传城市建筑文化。' },
    ] },
  { id: 'sun-island', names: ['太阳岛', '太阳岛风景区', '哈尔滨太阳岛风景区'],
    title: '哈尔滨市太阳岛风景区', publisher: '黑龙江省人民政府',
    url: 'https://www.hlj.gov.cn/hlj/c108519/202503/c00_31816708.shtml', publishedAt: '2025-03', reviewedAt: '2026-10-17',
    chunks: [
      { topic: '景区特色', text: '太阳岛风景区是哈尔滨的城市沿江生态游览区域。省政府介绍列出其国家级风景名胜区、国家湿地公园等身份，生态景观是理解这里的重要线索。' },
    ] },
];

const normalize = text => String(text || '').replace(/[\s·•（）()]/g, '');
function tokens(text) {
  const chars = Array.from(normalize(text));
  return [...new Set(chars.slice(0, -1).map((char, i) => char + chars[i + 1]))];
}
function retrieve(place, question) {
  const point = place && place.point;
  // 同名外地 POI 不能套用哈尔滨资料；这不是地点坐标生成器。
  if (!point || point.latitude < 45.3 || point.latitude > 46.3 || point.longitude < 125.7 || point.longitude > 127.3) return [];
  const name = normalize(place.name), terms = tokens(question);
  const docs = DOCUMENTS.filter(doc => doc.names.some(alias => normalize(alias) === name));
  return docs.flatMap(doc => doc.chunks.map((chunk, i) => ({
    chunkId: doc.id + ':' + i, text: chunk.text, topic: chunk.topic,
    source: { id: doc.id, title: doc.title, publisher: doc.publisher, url: doc.url,
      publishedAt: doc.publishedAt, reviewedAt: doc.reviewedAt },
    score: terms.filter(term => chunk.text.includes(term) || chunk.topic.includes(term)).length,
  }))).sort((a, b) => b.score - a.score).slice(0, 3);
}

module.exports = { retrieve, DOCUMENTS, KNOWLEDGE_VERSION };
