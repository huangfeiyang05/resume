const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const privateKey = /^(?:e-?mail|phone|mobile|tel|contact|wechat|weixin|qq|password|secret|access_token|authorization|openid)$/i;
function decoded(value: string): string {
  let text = value;
  for (let i = 0; i < 2; i++) {
    try { const next = decodeURIComponent(text); if (next === text) break; text = next; } catch { break; }
  }
  return text;
}

/** Query and fragment contact values remain private; numeric vacancy IDs are allowed. */
export function companyUrlContainsPrivateData(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || email.test(decoded(url.pathname))) return true;
    if ([...url.searchParams].some(([key, value]) => privateKey.test(decoded(key)) || email.test(decoded(value)))) return true;
    const fragment = decoded(url.hash.slice(1));
    if (email.test(fragment)) return true;
    return /(?:^|[?&;])(?:e-?mail|phone|mobile|tel|contact|wechat|weixin|qq|password|secret|access_token|authorization|openid)=[^&#;]+/i.test(fragment);
  } catch { return false; } // Structural URL validation is performed separately.
}
