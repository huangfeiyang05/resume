import { createHash } from 'node:crypto';

const sourceHeaders = ['更新/开启时间', '企业/招聘单位名称', '企业/单位性质', '行业分类', '招聘类型/批次', '招聘对象', '招聘岗位', '工作地点', '网申截止时间', '投递方式', '官方招聘推文', '备注'];
const outputHeaders = ['企业名称', '企业性质', '行业', '招聘类型', '招聘对象', '招聘方向', '工作地点', '学历', '企业简介', '招聘链接'];
const roleGroups: Array<[string, RegExp]> = [
  ['软件与计算机', /软件|计算机|前端|后端|嵌入式|程序员|Java|C\+\+|信息技术|运维工程|测试工程/i],
  ['数据与算法', /算法|数据分析|数据工程|大数据|人工智能|机器学习|数据科学|数据开发/],
  ['硬件与电子', /硬件|电路|电子|芯片|半导体|射频|集成电路/],
  ['机械与制造', /机械|制造|工艺|设备|生产|数控/],
  ['电气与自动化', /电气|电力|自动化|控制工程|强电|弱电/],
  ['材料与化工', /材料|化学|化工|冶金|高分子/],
  ['土建与工程', /土木|建筑|施工|造价|测绘|工程管理|结构工程/],
  ['财务与审计', /财务|会计|审计|税务/],
  ['金融与投资', /金融|银行|投资|证券|保险|信贷|资金|资产/],
  ['市场与销售', /市场|销售|商务|客户经理|营销|业务拓展/],
  ['产品与运营', /产品经理|产品运营|用户运营|内容运营|电商|新媒体/],
  ['人力与行政', /人力|人事|招聘专员|行政|党务|综合管理|文秘/],
  ['法务与合规', /法务|法律|合规/],
  ['物流与采购', /物流|供应链|采购|仓储|物料/],
  ['设计与创意', /视觉|平面设计|交互|工业设计|动画|美术|摄影|UI设计/i],
  ['教育与教学', /教师|教学|教研|教育/],
  ['医学与健康', /医生|医师|护理|护士|医学|药学|医药|临床|卫生/],
  ['科研与实验', /科研|研究员|博士后|实验/],
  ['农林与食品', /农业|农学|林业|食品|园艺|畜牧|兽医|作物|农林/],
  ['语言与国际业务', /翻译|外语|国际业务|跨境|外贸/],
  ['质量与安全', /质量|质检|安全工程|质量管理|EHS/i],
  ['客户服务与支持', /客户服务|客服|技术支持|售后/],
  ['管理培训生', /管培|管理培训生/],
];
const industryGroups: Array<[string, RegExp]> = [
  ['互联网与软件', /互联网|软件|人工智能|网络安全|游戏|信息服务|大数据|云计算/],
  ['电子与半导体', /电子|半导体|芯片|集成电路|光学光电|计算机硬件/],
  ['能源与电力', /能源|电力|燃气|核能|光伏|储能/],
  ['金融与银行', /金融|银行|证券|基金|保险|信托|期货|投融资|信贷|信用社/],
  ['医疗与生命科学', /生物|制药|医药|医疗|生命科学|医院|健康|卫生/],
  ['机械与智能制造', /机械|装备|自动化|仪器|智能制造|电气系统|工业制造/],
  ['汽车与出行', /汽车|车企|车载|智能驾驶|出行/],
  ['建筑土木与房地产', /建筑|土木|房地产|地产|建筑工程|基础建设|建材|施工/],
  ['材料与化工', /材料|化工|化学|冶金|有色金属|钢铁|矿产/],
  ['教育与科研', /教育|学校|高校|科研|研究院|研究所|培训/],
  ['农林与食品', /农|林业|食品|畜牧|养殖|牧业|粮油/],
  ['消费零售与商贸', /零售|商贸|消费品|服装|家居|家电|电商|日化|纺织/],
  ['通信与网络', /通信|通讯|电信|移动运营|网络设备/],
  ['交通与航空航天', /交通|航空|航天|铁路|轨道|船舶|港口|航运|机场/],
  ['物流与供应链', /物流|供应链|快递|仓储|货运/],
  ['传媒与文化', /传媒|文化|文娱|影视|出版|广告|新闻|广播/],
  ['公共管理与服务', /政府|公共服务|公共管理|政务|公共事业/],
  ['咨询与专业服务', /咨询|专业服务|审计|会计|法律|人力资源|检测|认证|检验/],
  ['环境与环保', /环境|环保|水务|固废|生态|污染治理/],
  ['旅游酒店与餐饮', /旅游|酒店|餐饮|文旅/],
  ['国防与军工', /国防|军工|兵器|兵装/],
];
const cityNames = ['北京','上海','天津','重庆','广州','深圳','杭州','南京','苏州','武汉','西安','成都','长沙','合肥','郑州','济南','青岛','厦门','福州','宁波','无锡','佛山','东莞','珠海','惠州','南昌','南宁','昆明','贵阳','太原','石家庄','哈尔滨','长春','沈阳','大连','海口','三亚','兰州','西宁','银川','乌鲁木齐','拉萨','香港','澳门','台北','常州','南通','扬州','镇江','徐州','盐城','泰州','淮安','连云港','温州','嘉兴','湖州','绍兴','金华','台州','舟山','丽水','衢州','泉州','漳州','莆田','龙岩','赣州','九江','芜湖','蚌埠','洛阳','新乡','许昌','焦作','烟台','潍坊','淄博','威海','临沂','泰安','济宁','德州','东营','聊城','菏泽','包头','呼和浩特','鄂尔多斯','唐山','保定','廊坊','秦皇岛','邯郸','沧州','衡水','淮南','阜阳','马鞍山','襄阳','宜昌','荆州','岳阳','株洲','湘潭','衡阳','绵阳','德阳','宜宾','泸州','乐山','自贡','达州','南充','遵义','六盘水','玉溪','曲靖','柳州','桂林','北海','中山','江门','汕头','湛江','肇庆','清远','韶关','茂名','揭阳','潮州','梅州','汕尾','阳江','河源','云浮','宝鸡','咸阳','榆林','延安','汉中','渭南','银川','大庆','齐齐哈尔','牡丹江','吉林','锦州','鞍山','营口'];
const provinces = /^(?:河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾)省/;
const clean = (value: unknown) => String(value ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\r\n?/g, '\n').trim();
const labels = (value: string) => [...new Set(value.split(/[\n、,，;；/|]+/).map(clean).filter(value => value && value.length <= 100))];
function locationLabels(value: string): string[] {
  return [...new Set(labels(value).map(item => {
    const candidate = item.replace(provinces, '');
    const city = cityNames.find(city => candidate === city || candidate.startsWith(`${city}市`) || candidate.startsWith(`${city}（`) || candidate.startsWith(`${city}(`));
    return city ?? item;
  }))];
}
const contact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[\t -]?\d){8}(?!\d)|(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)|(?:电话|手机|微信|QQ|群号|联系人|联系老师|联系方式|邮箱|邮件)/i;
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/.test(value.trim())) return;
    if ([...url.searchParams].some(([key, value]) => /^(?:password|secret|access_token|authorization|phone|mobile|email|openid)$/i.test(key) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value))) return;
    return url.href;
  } catch { return; }
}

/** Source-specific, deterministic preparation. It never fetches a page or executes source text. */
export function prepareCompanySheet(value: unknown, linksValue: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(linksValue)) throw new Error('Invalid sheet extraction.');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.headers) || !Array.isArray(input.rows) || !Array.isArray(input.rowNumbers) || input.rows.length !== input.rowNumbers.length || input.rows.length > 25_000) throw new Error('Invalid row coverage.');
  const headers = input.headers.map(clean);
  if (headers.length !== sourceHeaders.length || !sourceHeaders.every((header, index) => headers[index] === header)) throw new Error('Unexpected sheet columns; review mapping first.');
  const numbers = input.rowNumbers as unknown[];
  if (numbers.some(row => !Number.isSafeInteger(row) || (row as number) < 1) || new Set(numbers).size !== numbers.length) throw new Error('Invalid source row numbers.');
  const links = new Map<string, string[]>();
  let discardedLinks = 0;
  for (const value of linksValue) {
    if (!value || typeof value !== 'object') throw new Error('Invalid source hyperlink.');
    const cell = value as Record<string, unknown>;
    if (!Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column) || !Array.isArray(cell.hrefs)) throw new Error('Invalid source hyperlink.');
    const key = `${cell.row}:${cell.column}`, values = links.get(key) ?? [];
    for (const href of cell.hrefs) { const safe = safeUrl(href); if (safe) values.push(safe); else discardedLinks++; }
    links.set(key, [...new Set(values)]);
  }
  const source = input.source as Record<string, unknown> | undefined;
  const notices = Array.isArray(source?.stoppedUpdatingNotices) ? source.stoppedUpdatingNotices : [];
  const archived = notices.some(value => /不再更新|停止更新|更新完毕/.test(typeof value === 'string' ? value : JSON.stringify(value)));
  const rows: string[][] = [];
  let contactDeliveryRows = 0, excludedRemarkRows = 0, unclassifiedDirectionRows = 0, unclassifiedIndustryRows = 0;
  for (let index = 0; index < input.rows.length; index++) {
    const raw = input.rows[index];
    if (!Array.isArray(raw) || raw.length !== sourceHeaders.length || raw.some(cell => typeof cell !== 'string' && typeof cell !== 'number' && cell !== null)) throw new Error('Invalid source cell.');
    const cells = raw.map(clean), row = numbers[index] as number;
    const positions = cells[6], audience = cells[5];
    const directions = roleGroups.filter(([, expression]) => expression.test(positions)).map(([label]) => label);
    if (!directions.length) unclassifiedDirectionRows++;
    const industries = industryGroups.filter(([, expression]) => expression.test(cells[3])).map(([label]) => label);
    if (cells[3] && !industries.length) unclassifiedIndustryRows++;
    const education = [...new Set(audience.match(/(?:本科|硕士(?:研究生)?|博士(?:研究生)?|专科|大专)(?:及以上)?/g) ?? [])];
    const cohorts = labels(audience).filter(value => !/^(?:本科|硕士(?:研究生)?|博士(?:研究生)?|专科|大专)(?:及以上)?$/.test(value));
    const deliveryUrls = [...new Set([...(links.get(`${row}:10`) ?? []), ...((cells[9].match(/https?:\/\/[^\s<>"']+/g) ?? []).map(safeUrl).filter((value): value is string => !!value))])];
    const announcementUrls = links.get(`${row}:11`) ?? [];
    const primary = deliveryUrls[0] ?? announcementUrls[0] ?? safeUrl(cells[10]);
    const deliveryHasContact = contact.test(cells[9]);
    if (deliveryHasContact) contactDeliveryRows++;
    if (cells[11]) excludedRemarkRows++;
    const additional = [...new Set([...deliveryUrls, ...announcementUrls])].filter(value => value !== primary);
    const description = [
      archived ? '来源状态：本表已停止更新，以下为历史招聘资料，不能据此判断当前在招。' : '来源状态：按来源记录整理，当前招聘安排需要重新核对。',
      `来源开启/更新日期：${cells[0] || '未提供'}`,
      `来源截止说明：${cells[8] || '未提供'}（仅保留原表信息，不代表当前仍可投递）`,
      `招聘对象原文：${audience || '未提供'}`,
      `招聘岗位原文：${positions || '未提供'}`,
      `行业原文：${cells[3] || '未提供'}`,
      `工作地点原文：${cells[7] || '未提供'}`,
      deliveryHasContact ? '投递说明：来源含联系渠道，请回原表核对；此处仅保留招聘网页链接。' : cells[9] ? `投递说明原文：${cells[9]}` : '',
      additional.length ? `其他来源链接：\n${additional.join('\n')}` : '',
    ].filter(Boolean).join('\n');
    rows.push([cells[1], cells[2], industries.join('\n'), labels(cells[4]).join('\n'), cohorts.join('\n'), directions.join('\n'), locationLabels(cells[7]).join('\n'), education.join('\n'), description, primary ?? '']);
  }
  return {
    table: { headers: outputHeaders, rows, rowNumbers: [...numbers] as number[] },
    report: { version: 1, classificationVersion: 'source-keywords-v1', inputRows: rows.length, archivedSource: archived, contactDeliveryRows, excludedRemarkRows, discardedLinks, unclassifiedDirectionRows, unclassifiedIndustryRows, sourceRowsHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), sourceLinksHash: createHash('sha256').update(JSON.stringify(linksValue)).digest('hex') },
  };
}
