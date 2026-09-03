/**
 * Edge HTML-to-Markdown and token optimization converter
 * Converts messy HTML emails into clean, compact Markdown for LLMs.
 */

export function htmlToMarkdown(html: string): string {
  if (!html) return '';

  let text = html;

  // 1. Strip scripts, styles, XML, head, and comments
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\?xml[\s\S]*?\?>/gi, '');

  // 2. Remove hidden tracking elements (display:none, font-size:0, 1x1 images)
  text = text.replace(/<img[^>]*width=["']?1["']?[^>]*height=["']?1["']?[^>]*>/gi, '');
  text = text.replace(/<[^>]+style=["'][^"']*(?:display:\s*none|font-size:\s*0)[^"']*>[^<]*<\/[^>]+>/gi, '');

  // 3. Headers (h1 - h6)
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n\n# $1\n\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n\n## $1\n\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n\n### $1\n\n');
  text = text.replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n');

  // 4. Blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, p1) => {
    const lines = p1.trim().split('\n');
    return '\n' + lines.map((l: string) => `> ${l.trim()}`).join('\n') + '\n';
  });

  // 5. Links: <a href="url">text</a> -> [text](url)
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_match, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
    if (!cleanLabel) return '';
    if (href === cleanLabel) return href;
    return `[${cleanLabel}](${href})`;
  });

  // 6. Bold and italics
  text = text.replace(/<(?:strong|b)[^>]*>(.*?)<\/(?:strong|b)>/gi, '**$1**');
  text = text.replace(/<(?:em|i)[^>]*>(.*?)<\/(?:em|i)>/gi, '*$1*');
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // 7. Unordered lists and list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1');
  text = text.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n');

  // 8. Paragraphs and breaks
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // 9. Tables: Simplify cells and rows
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n');
  text = text.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, ' $1 |');
  text = text.replace(/<\/?table[^>]*>/gi, '\n');
  text = text.replace(/<\/?tbody[^>]*>/gi, '');
  text = text.replace(/<\/?thead[^>]*>/gi, '');

  // 10. Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // 11. Decode common HTML entities
  text = decodeHtmlEntities(text);

  // 12. Normalize whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Truncate long content to respect AI token limits
 */
export function truncateForAI(content: string, maxChars = 15000): { text: string; truncated: boolean } {
  if (!content || content.length <= maxChars) {
    return { text: content, truncated: false };
  }

  const truncatedText = content.slice(0, maxChars) + `\n\n[... Remaining content truncated (${content.length - maxChars} characters omitted) ...]`;
  return { text: truncatedText, truncated: true };
}
