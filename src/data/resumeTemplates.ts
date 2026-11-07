import type { ResumeExportTemplate } from '../../shared/resume-layout';

export interface ResumeWordTemplate {
  id: 'light-blue' | 'monochrome' | 'navy';
  name: string;
  caption: string;
  layout: ResumeExportTemplate;
  description: string;
  previewUrl: string;
  downloadUrl: string;
  fileName: string;
}

/** Public, placeholder-only Word files and previews approved for the template gallery. */
export const resumeTemplates: readonly ResumeWordTemplate[] = [
  {
    id: 'monochrome',
    name: '经典简约',
    caption: '黑白简约',
    layout: 'minimal',
    description: '黑白单栏与细线标题，姓名、学历和经历层次清晰，右上保留照片位。',
    previewUrl: '/static/resume-templates/classic-onyx.jpg',
    downloadUrl: '/static/resume-templates/classic-onyx.docx',
    fileName: '01_经典简约.docx',
  },
  {
    id: 'light-blue',
    name: '现代留白',
    caption: '浅蓝留白',
    layout: 'modern',
    description: '浅蓝左侧栏收纳照片、技能、证书与自我评价，右侧留白呈现学历和经历。',
    previewUrl: '/static/resume-templates/blue-azurill.jpg',
    downloadUrl: '/static/resume-templates/blue-azurill.docx',
    fileName: '02_现代留白.docx',
  },
  {
    id: 'navy',
    name: '专业商务',
    caption: '深蓝商务',
    layout: 'business',
    description: '白色主栏搭配深海军蓝右侧栏，以清晰的字重和间距呈现学历、经历与个人优势。',
    previewUrl: '/static/resume-templates/navy-chikorita.jpg',
    downloadUrl: '/static/resume-templates/navy-chikorita.docx',
    fileName: '03_专业商务.docx',
  },
];
