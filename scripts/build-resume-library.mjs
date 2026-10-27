import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'docs/resume-library');
const catalogue = JSON.parse(await readFile(path.join(base, 'sources.json'), 'utf8'));
const playbooks = JSON.parse(await readFile(path.join(base, 'playbooks.json'), 'utf8'));
const byId = new Map(catalogue.sources.map((s) => [s.id, s]));
let assets = [];
try {
  assets = JSON.parse(await readFile(path.join(root, '.data/resume-reference-corpus/manifest.local.json'), 'utf8')).assets;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const byAsset = new Map(assets.map((a) => [a.id, a]));
const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
await mkdir(path.join(base, 'templates'), { recursive: true });

const table = [
  '# 按专业查阅简历参考资料', '',
  `整理日期：${catalogue.collectedOn}。本批 ${catalogue.sources.length} 条来源记录、${playbooks.tracks.length} 个专业大类/求职方向。各专业目录可能重复引用同一来源，不按链接出现次数计算资料数量。`, '',
  `本机已保存 ${assets.filter((a) => a.status === 'downloaded').length} 份文件；失败 ${assets.filter((a) => a.status === 'failed').length} 份。下载记录与 SHA-256 见 [本机清单](../../.data/resume-reference-corpus/manifest.local.json)。`, '',
  '“高质量”筛选依据为发布来源、文件可读性、结构清晰与专业证据表达，不代表已验证录用效果、ATS通过率或适用于所有地区。', '',
  '所有外部原件默认不进入共享AI提示、向量库或训练集。高校教学样例不是本产品的模板授权；仅有许可证的布局代码另行标注，其人物内容仍不可挪用。', '',
  '## 快速选择专业', '',
  '| 专业大类/方向 | 原创中文内容模板 | 参考来源数 |',
  '| --- | --- | --- |',
  ...playbooks.tracks.map((track) => `| ${track.name} | [打开填写骨架](templates/${track.id}.md) | ${track.sourceIds.length} |`), '',
];

function sectionDraft(section, track) {
  if (section === '教育经历') return '[真实学校] · [真实专业] · [真实学历] · [真实起止时间]\n\n[仅填写真实且与目标岗位相关的课程、成绩或研究方向；无相关信息可省略。]';
  if (/技能|能力|工具/.test(section)) return '[实际掌握或使用过的方法/工具/语言]：[真实使用场景与证据；熟练程度不明时不要推断。]';
  if (/资质|认证|培训/.test(section)) return '[真实证书/资格/培训名称] · [取得/在考等真实状态] · [真实时间]\n\n[没有则删除；不得把计划报考写成已经取得。]';
  if (/公开成果|论文|展览|作品/.test(section)) return '[真实成果/作品名称] · [本人贡献或署名] · [真实状态与时间]\n\n[获准公开的链接或说明；论文投稿中不能写成发表，无相关内容则删除。]';
  if (/校园|志愿|公益/.test(section)) return '[真实活动/组织] · [本人角色] · [真实时间]\n\n- [本人实际行动、真实交付与可说明反馈；未发生的过程或结果不填写。]';
  return `[真实项目/单位/课程/实践名称] · [本人角色] · [真实起止时间]\n\n- ${track.bulletSkeleton}\n- [补充有来源的交付或过程证据；没有数字、反馈、改进或复核时可省略，不为凑齐结构而编造。]`;
}

for (const track of playbooks.tracks) {
  const relevant = track.sourceIds.map((id) => byId.get(id));
  if (relevant.some((s) => !s)) throw new Error(`Missing source for ${track.id}.`);
  const template = [
    `# ${track.name}：原创填写骨架`, '',
    '> 这是未填写的内容模板，不是已完成简历。所有占位都待确认；只能填写真实事实，补齐并审核前不得应用。反馈、改进、复核等未发生时可以删除。', '',
    '姓名：[本人真实姓名]', '',
    '联系方式：[本人选择用于求职的联系方式]；目标岗位：[希望投递的真实岗位]', '',
    '下列栏目按与目标岗位的相关性调整顺序。没有的经历或资质直接删掉，不为匹配模板而添加事实。', '',
    ...track.sectionOrder.flatMap((s) => [`## ${s}`, '', sectionDraft(s, track), '']),
    '## 填写前先回答', '', ...track.focusQuestions.map((q) => `- ${q}`), '',
    '## 审核重点', '', ...track.redFlags.map((flag) => `- 检查是否存在：${flag}。`), '',
    '## 结构参考来源', '',
    '以下材料只用于核查栏目与表达思路；这个中文骨架是本项目原创，未复制参考人物或原简历段落。', '',
    ...relevant.map((s) => `- [${s.publisher}：${s.title}](${s.landingUrl})。${s.qualityCaveat}`), '',
    '这份骨架没有接入当前产品模板中心，也未经过模型质量评测；它不是 shared/types.ts 中的已保存简历或诊断响应。', '',
  ].join('\n');
  await writeFile(path.join(base, 'templates', `${track.id}.md`), template);
  table.push(`## ${track.name}`, '', `相关专业举例：${track.majors.join('、')}；方向：${track.roles.join('、')}。`, '',
    `[原创填写骨架](templates/${track.id}.md) · 专业提示卡：playbooks.json 中的 ${track.id}`, '',
    '| 来源 | 类型/语言 | 实际获取状态 | 适用限制 |', '| --- | --- | --- | --- |');
  for (const source of relevant) {
    const local = byAsset.get(source.id);
    let state = source.kind === 'guide' ? '指南正文已读' : source.curationTier === 'preview_only' ? '页面预览已读，附件未取得' : '页面或文件已读，尚未本机保存';
    if (local?.status === 'downloaded') state = `[本机原件](../../${local.rawPath})`;
    else if (local?.status === 'failed') state = `本次下载失败：${local.error}`;
    table.push(`| [${escape(source.publisher)}：${escape(source.title)}](${source.landingUrl}) | ${escape(source.kind)} / ${escape(source.language)} | ${escape(state)} | ${escape(source.qualityCaveat)} |`);
  }
  table.push('');
}
table.push('## 仅发现入口、尚未读取附件', '',
  ...catalogue.sources.filter((s) => s.curationTier === 'discovery_only_content_unread').map((s) => `- [${s.publisher}：${s.title}](${s.landingUrl})。${s.verification} ${s.qualityCaveat}`), '',
  '## 来源与授权记录', '',
  '机器可读来源目录见 [sources.json](sources.json)，每条包含核验日期、可读性证据、适用限制、授权状态和自动使用权限。已下载原件、提取文本、预览图、哈希及失败记录位于忽略的 .data/resume-reference-corpus/；不提交Git、不打包到客户端、不直接作为共享知识库。', '');
await writeFile(path.join(base, 'catalog.md'), table.join('\n'));
console.log(`Generated ${playbooks.tracks.length} original content skeletons and catalogue.`);
