export function recruitmentCohortYear(label: string): number | undefined {
  const year = /^(20\d{2}|\d{2})(?:\s*[届年])?(?:\s*(?:应届生|(?:应届)?毕业生|毕业))?$/.exec(label.normalize('NFKC').trim())?.[1];
  return year ? Number(year.length === 2 ? `20${year}` : year) : undefined;
}

export function shortRecruitmentCohort(label: string): string {
  return label.replace(/^20(\d{2}届)$/, '$1');
}

/** Match explicit graduating classes. Calendar dates alone do not establish a cohort. */
export function matchesRecruitmentCohort(text: string, year: number): boolean {
  const normalized = text.normalize('NFKC');
  for (const match of normalized.matchAll(/(?<!\d)(20\d{2}|\d{2})\s*届(?:\s*(及以后|之后|以后))?/g)) {
    const prefix = normalized.slice(0, match.index).split(/[，,。；;、\n]/).at(-1) ?? '';
    const suffix = normalized.slice(match.index + match[0].length);
    if (/(?:不招(?:收)?|不接受|不面向|排除|除|非)\s*$/.test(prefix) || /^\s*\(?\s*(?:除外|以外|之外)/.test(suffix)) continue;
    const specified = recruitmentCohortYear(match[1])!;
    if (match[2] ? year >= specified : year === specified) return true;
  }
  return false;
}
