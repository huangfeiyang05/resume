/** Shared input boundaries for UI, file import and API validation. */
export const inputLimits = {
  bodyBytes: 256 * 1024,
  resumeText: 50_000,
  jobDescription: 15_000,
  title: 120,
  targetRole: 120,
  replacement: 20_000,
} as const;
