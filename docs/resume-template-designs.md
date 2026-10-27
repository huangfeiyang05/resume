# 简历模板设计来源

2026-10-15 按用户要求，从网上选取成熟的开源简历版式，适配中文占位内容、网站正文预览、Word / PDF 导出与可编辑 Word 文件。此次替换不运行测试、构建或视觉验收，由用户自行检查。Word 渲染仅用于生成网站需要的预览图片。

参考源码版本：`reactive-resume/reactive-resume@19e0518eb5ea1b2c84d785bc5ea2b6d6c9d7b043`。

## 三款对应关系

| 本站风格 | 开源参考 | 中文适配 |
| --- | --- | --- |
| 经典简约 | Reactive Resume Onyx | 黑白单栏、清晰姓名、细分隔线、右上照片位 |
| 现代留白 | Reactive Resume Azurill | 左侧约 29% 浅蓝辅助栏，右侧白色主栏；照片、技能、证书、自我评价放侧栏 |
| 专业商务 | Reactive Resume Chikorita | 右侧约 30% 深海军蓝辅助栏，左侧白色主栏；原模板绿色改为 `#17324d` |

三款按各自参考的视觉结构重排，不直接使用参考简历中的姓名、联系方式、头像、学校、公司或业绩。Word 只包含填写提示；工作/实习与项目保留“项目描述、职责范围、技术栈或工具方法、工作要点”的内容结构。实际用户正文仅根据明确栏目标题分栏，不补写缺失资质；没有辅助栏目时使用完整主栏，窄屏依次显示主栏与辅助栏。栏目正文内部的文字与顺序保持不变。

## 官方资料

- [项目与模板目录](https://github.com/reactive-resume/reactive-resume)
- [官方模板展示](https://rxresu.me/)
- [Onyx 源码](https://github.com/reactive-resume/reactive-resume/blob/main/packages/pdf/src/templates/onyx/OnyxPage.tsx) · [预览](https://raw.githubusercontent.com/reactive-resume/reactive-resume/main/apps/web/public/templates/jpg/onyx.jpg)
- [Azurill 源码](https://github.com/reactive-resume/reactive-resume/blob/main/packages/pdf/src/templates/azurill/AzurillPage.tsx) · [预览](https://raw.githubusercontent.com/reactive-resume/reactive-resume/main/apps/web/public/templates/jpg/azurill.jpg)
- [Chikorita 源码](https://github.com/reactive-resume/reactive-resume/blob/main/packages/pdf/src/templates/chikorita/ChikoritaPage.tsx) · [预览](https://raw.githubusercontent.com/reactive-resume/reactive-resume/main/apps/web/public/templates/jpg/chikorita.jpg)
- [MIT 许可证](https://github.com/reactive-resume/reactive-resume/blob/main/LICENSE)

保留的许可声明见根目录 `THIRD_PARTY_NOTICES.md` 与公开静态目录 `LICENSE-reactive-resume.txt`；独立下载的 Word 文件在文档元数据中附带设计来源与许可。参考源码保存在忽略目录 `.data/layout-qa/design-references/`，不引入上游应用的运行时、账户系统、外部请求或模型功能。

## 文件维护

- 网站目录：`src/data/resumeTemplates.ts`
- 正文预览：`src/components/ResumeDocument.vue`
- Word / PDF 导出：`server/export-renderer.ts`（版式列分配见 `shared/resume-layout.ts`）
- Word 生成：`scripts/build-resume-word-templates.py`
- 公开占位资产：`src/static/resume-templates/classic-onyx.*`、`blue-azurill.*`、`navy-chikorita.*`
- 本地可编辑副本：`outputs/简历Word模板/01_经典简约.docx`、`02_现代留白.docx`、`03_专业商务.docx`

公开目录仅用于无个人信息的占位模板。用户填写的正文、真实照片和下载后的个人简历仍留在私有或本地位置。
