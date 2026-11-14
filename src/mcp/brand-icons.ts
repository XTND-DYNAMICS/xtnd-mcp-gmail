/**
 * First-party brand icon assets for XMAIL | Gmail MCP discovery & SEP-973 metadata.
 * Served unauthenticated with Cross-Origin-Resource-Policy: cross-origin so
 * ChatGPT, Claude (Web/iOS/Desktop), Codex, Antigravity, and favicon proxies render crisp brand marks.
 */

export const BRAND_ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\" width=\"100%\" height=\"100%\">\n  <defs>\n    <linearGradient id=\"bgGrad\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n      <stop offset=\"0%\" stop-color=\"#0f172a\"/>\n      <stop offset=\"100%\" stop-color=\"#020617\"/>\n    </linearGradient>\n    <linearGradient id=\"gmailRed\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n      <stop offset=\"0%\" stop-color=\"#ff6b6b\"/>\n      <stop offset=\"100%\" stop-color=\"#ea4335\"/>\n    </linearGradient>\n    <linearGradient id=\"gmailBlue\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n      <stop offset=\"0%\" stop-color=\"#60a5fa\"/>\n      <stop offset=\"100%\" stop-color=\"#4285f4\"/>\n    </linearGradient>\n    <linearGradient id=\"gmailGreen\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n      <stop offset=\"0%\" stop-color=\"#4ade80\"/>\n      <stop offset=\"100%\" stop-color=\"#34a853\"/>\n    </linearGradient>\n    <linearGradient id=\"gmailYellow\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">\n      <stop offset=\"0%\" stop-color=\"#fde047\"/>\n      <stop offset=\"100%\" stop-color=\"#fbbc05\"/>\n    </linearGradient>\n    <filter id=\"glow\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\">\n      <feGaussianBlur stdDeviation=\"10\" result=\"blur\"/>\n      <feComposite in=\"SourceGraphic\" in2=\"blur\" operator=\"over\"/>\n    </filter>\n  </defs>\n\n  <!-- Rounded Squircle Background -->\n  <rect width=\"512\" height=\"512\" rx=\"128\" fill=\"url(#bgGrad)\"/>\n  <rect width=\"508\" height=\"508\" x=\"2\" y=\"2\" rx=\"126\" fill=\"none\" stroke=\"rgba(255,255,255,0.1)\" stroke-width=\"4\"/>\n\n  <!-- Neural Connection Lines -->\n  <g opacity=\"0.3\" stroke=\"#4285f4\" stroke-width=\"2\" stroke-dasharray=\"4,4\">\n    <line x1=\"120\" y1=\"140\" x2=\"256\" y2=\"256\"/>\n    <line x1=\"392\" y1=\"140\" x2=\"256\" y2=\"256\"/>\n    <line x1=\"256\" y1=\"256\" x2=\"256\" y2=\"390\"/>\n  </g>\n\n  <!-- Outer Glow Envelope / M Shape -->\n  <g filter=\"url(#glow)\">\n    <!-- Left Column -->\n    <path d=\"M 120 160 L 120 340\" stroke=\"url(#gmailBlue)\" stroke-width=\"18\" stroke-linecap=\"round\"/>\n    <!-- Right Column -->\n    <path d=\"M 392 160 L 392 340\" stroke=\"url(#gmailGreen)\" stroke-width=\"18\" stroke-linecap=\"round\"/>\n    <!-- Diagonal Left Flap -->\n    <path d=\"M 120 160 L 256 270\" stroke=\"url(#gmailRed)\" stroke-width=\"18\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n    <!-- Diagonal Right Flap -->\n    <path d=\"M 392 160 L 256 270\" stroke=\"url(#gmailYellow)\" stroke-width=\"18\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n    <!-- Top Bar -->\n    <path d=\"M 135 155 L 377 155\" stroke=\"url(#gmailRed)\" stroke-width=\"12\" stroke-linecap=\"round\"/>\n  </g>\n\n  <!-- Central Intelligence Core -->\n  <circle cx=\"256\" cy=\"270\" r=\"26\" fill=\"#0f172a\" stroke=\"url(#gmailBlue)\" stroke-width=\"6\"/>\n  <circle cx=\"256\" cy=\"270\" r=\"10\" fill=\"#ea4335\"/>\n\n  <!-- XTND Wordmark Subtitle -->\n  <text x=\"256\" y=\"440\" text-anchor=\"middle\" font-family=\"-apple-system, BlinkMacSystemFont, 'Inter', sans-serif\" font-weight=\"900\" font-size=\"32\" letter-spacing=\"8\" fill=\"#f8fafc\">\n    XTND<tspan fill=\"#ea4335\">\u00b7</tspan>GMAIL\n  </text>\n</svg>";
const FAVICON_ICO_B64 = "AAABAAEAICAAAAEAIADXAgAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgDAAAARKSKxgAAAP9QTFRFCxEkBQobAAAACA4gEBYn////////LjREhIiRY2dy0NHURkpXcnaBLCYvVlpmLjJDPkJPKBsrf39/FTZkKCw7ZWl1XGBs7skzZFcnZSUs+WZlL0x36FVR/tUzqUhNKi9ASjZQCw8gcDVAHiAkOjUksZUraDQ/eGYnNFd1XWBrzMzQ17YzVEkkqDg2foGJ01BPbnF8jHku11pgDhIfhYiRoIYqIB0czawuVCk0jT9I4MRQyEpIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArne5pAAAAEB0Uk5T/v4A/rICLP/Lk03/9v//sP//Av+w////////////////s/////////+WTP///8//7v//////////////AAAAAJhYavIAAAFHSURBVHjahZPXloMwDERHFoReEtLLpm/vvfz/f60MaYDZ1QPmnLmMjaWBUspWDaUF6MX2vcSqVOL5tiYgj5broFYMx22JCNFDEAwEUSgEOrYLUzGDyLU7UL5j/J41MfflDB4adGZiT4DE7J8D1BXA+kNn6wC0o7J/tCYqAefj1fEGGMPBUAN04nA2/joST7M3VABgNT5rs36haDu7eKEagM/pQ6R/bXMzuCUyAGj/TEdYDwcfGzIDjLvnyeR7C2oAhJiMRpfvRI0OlC0WGXEDoO8OWXayQRko2lOpE2DXP6AB4H2D2Qzs9Sqw3AF8bHDdIck12bp2QioGxiv0MOjHYS+W9TXoBbFTAFeqGFox7jtO2o8D6qUip2mQ69G10mNPOWGqexl7HZx8uqh+ikcdnDx689oFaP8iervwdsvRXVrdQ3j/if8vouIRXjPZZk0AAAAASUVORK5CYII=";
const ICON_180_PNG_B64 = "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";
const ICON_192_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAA/1BMVEVZXGff4OOeoahjWCtYMS5TmPXmVFEjLkb09PVyeYlcNEf9/f3tRDXx8fKrjyzVsS8zQ2KrR0y/v78zXqK1t8KWNjdYXWiKdCl+gIiPPEOcn6V/f38tIhw/P38xN0ZCe9LRPTM9dc5/f7++wMWWcZd/v7/lw0AsMz8LEiQFChwAAAAIDiAnKDH9/f0QFB7///8rGyr6zTIlKjsfJDNQJzMdIjLzV1IAAD8/Pz8APz/7ZmVRSCY3NCX+0zIxNkX7+/sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACELDa+AAAAQHRSTlP+8v7//////yn+/6r/Yv///v8E//7/UP/+/1AE/wRQ////BP7/BP9Q/v4A/v79/wP//1BQ//7/BAQE//////5PM+NwDwAADKZJREFUeNrtnYt22roShmXjgB1CQkJC2/S+e/Y5EjIh6cZtUoh5/7faM5Jv2LKRjY3VdarVRSjm8n+afyT5JpHFb17IH4A/AH8ANMtqtbq5uXn/8blRecF/LwcKvO/je/gR+Kl2AVZ1vrGlovubROeb5F/X3e0m9/P5p++dlU/z+f1kt3Pd1d5PHwMgvsLdTcaWZdseIdMwDEeF4o/8dsooDAnxbNuyxpOdG/9+cwChfjJeLi2bhAE9XQmJbS2X44kbiWgGgPQ7oX56MvGc8/jpVDDsDkSBVMuHr7CJT09dIoqA2FB91Qikwj1SfkD7KRIiQagJAMgumqc3+RkENJJbGgRSVv0TkO/1KV8yCCMBwqQsCEStfwXVb4c06LX6uXyANgl8NF6pCYhSvwvMb4Og77rnssAzD/zgKgmIUj+6nwZ9myfWjwhoIyUBUejfgf6Q9l54WhjYCAh2CgJSot+A6s8R+GoCovLPrR8YVP1xIvi3KhcRlf8N1C8IVHlA8kNnq3f/UK7SHxFY+SF2DmAxNkM/VRNAJo8XFQAr7H9J/70vVxfIZIJ98qoMAKID/Zep8iUB9Gj7JiI5A9k997+cVgAggZ0zEdnvAXpOgGr5Ig8gDfZ6gywAtECeec1nMQ2slRJABCAIzAZAgv0QkL0AEMMDIEy0HwKS6nchg42XL/PYTQlItgki5uuXIcg0RCQzCLo1PwAsDkFCQDKdMOlVfK0QTBQAY8vvdQdYrzAmGqJxHgAdZJvcgSUWYmzfQxmAqen5y2SBEIQKgIkV9Hr8pA4CeGhSABj36iBt+0QA9jgPsLKI6R0ASwscZVntAcBRr94OpGj6h4kGKAYIrfhAXQzg9jOM4PqFZSNAbbcA8Nv4RwVws9h5ZuvfJ+Dc24HoPQDSz/hBs+5zEWCc7AP8vZgQUwPAeEE+AkwWf2UA3i/upz2MHvRHoPlCw3sQnQJ8XMxDY45fVedvFIFwDqJTgOceAKj+8LPoIe7PQXQW4FNoahfAlBHwv+cAvo8M3AVgJfIlwEvfAM3rHwH+6RNA2fwU2Fh5APoFUI7/ccNDVFI8xsyMgFI/Kn+IKKhq/NASwOPI7+L0kaj4Bx+PLQuEav2NAR6hwGVJj4/HnL5W1z+cQPK34qInGsWAsdYBhHrfPweCx/bqX9gH5H/YbrZbhAhkCNoHQP3r8/P1en3ePAil+rcbx9kMBsAgYlCpvykA6B/++jU8B4rGQeD7g2ia6h9sBlevr1cbIMAQdAMwBIBfv64hBuf1CRTtp9BPA98H+ZvLp9enp9erKASVAKwhwPqXLNcOOMlvQlBiHzTP5SvoB4aNAGCdRCAGSGx0rPw9+zw9SYBtdxHwr4cxwjvHqR2DstYTqv/Nk9T/9Hq57RBgvb6OAYSN6qVyif23A7BPqj9KYtYFQJ4AGlTdIBRGz6l9NpvI/uify42zFR1BFwAiBBmCIaayVgw4LU9fqP+ruPqf3mw2Wo2QAsCnmiFYv0vy4Mc7/VQutf/mTaL/CtpSR0t/Q4CI4HyYTYS1TiKU2X+TtX9Gf1cAEYGTTQTnkI1Kei+QvyWD1P6vl4PEPwf1NwaQ46EsASTC+hBBSeuPvddVmr519DcHSBLhR6QfCNaVMcglME3tTwYZ+0P6Ovr6jwGIbSQSYQiDI0jl8uZUPfYM8r2XsH8N/UcBZBIB6n/4Yzi8lnnwqFv/Adgf6j+2/5OwvxONQrX0HweQJALqBwJAKLdRVevfzP4tAGQS4QfoFwQlqazRe129qa8fAX4eA5AkgtCP5U4ZA43BW237twOQJEJCcH2+LvRpmREQTVv/zeAo+7cEgEcoRCL8SAgyqcwLAUj0o30u8/YP6slvBSBNhLgMcXiajYHKPrL3SgZvDezfHkCSCAnCXTo85ereyzne/i0CoI32Cd6lMVC3/oXBW337twmgSITzJBGK6etsFPZvUP0tAsQ2uttLBCcbBFq273KM/hYBCjYa3p1nCWg2fXP7Ls31twlQTIR8n1a273KE/lYBionwzlmngztZ/dneK9l3CR6a6m8XIA5CmggXTmqjyD7kuMFbxwDFRIhS+cPDw4eC/SF9nSP1tw6QIxjKVAbtYbjdfhgMSIv27wZAnLwBgjs5uoZy55x7Z6J4JG//hr1XpgStAySJMJT6h8P/nCXFbtP+nQHkCG6h6kdwzi4YYSCEg5rtu5wOAAkckQjD4QXon+K1YZSyhynGoDX7dwTAs4kwvAD/jFi8jY2Eiy6PGLydAIDzrI2w/tONDGLw3+N7r44tlBA4awdsL15b392txZPPZ6Qt+3cFwNMYOAAgAuBcQHFkCLyB057+rgBiAh8yAJ9diIIjCsiCtuzfCcD+3lcM4EgARwJsPwSt6W8bIL//+6gCaK/6O42ARDg7E9fgSQAqAD7TFvW3BsCVl09SNjubYRKvv1xcfMFmCF94oO3pbzECqov3RM8lN69lKwrNKPRr7elvCYCXXbxHHz7LEMQd2ezsK+zYM2ZkBFQAGIKUAPRjAJhxAOX374jBwyxgDGz/EMzEwIJ1CPDSOInLLl8VBGez6Wg0Bfmt62+vFSq/X5CNZvH+zGzEOGMGRqDy6mGo8tFs9vXrDOS3Xf8tAWhfN8zbrv9WAHQu/o87OmYggObNC9CGdiD/eADt+2dZN/rbiAD/vSPwewPwOvevGWkhff3GRYDr2z8GMC4CvM79X5wbCaBT/Vze/m6ghfT9I26cNSoCnNe/f98gAF6jA4vvojXMQpwfd/9arwCc1p7/wbQI1L993LB+4Ij7f82wUH37mxMB3vT2X2MAmtS/UUMJ/QGcgRbSHYGqKpyaEQF9+xiZA3oDOFX9m2AhrpvBXe08thGBBtO3GGMh3fnHyn6ofwBDRp9ND68fLf9EEYCpSfzj9h9PDVCYmmQ+ajr/oWg+T+6h3OQwZdPzGJoARQCYICnM7fvWaED7KLkJkv5STVHFza1/xqb7U1SpJgmrc/Tn9IUUZjnzms+/ZACAYqI8k/0DRTnTH9c7AZxOMB69FcKQPDAevbS3V8azu2fpxKHpDKJ1S3GqQpwskutUfvKDPHv0JPovZ0VJvKHG6lY0N1nk/nSd1eeMCAnhwQvhW4goVDyDhgEeKAvxJX9vl4DAUlpykk0yRfvim1GE+BJsEsULfvSyXgrkpuvMTpha3f1SZi8tBpNvBxweRQG18CyEDTbDzVhIXOWc4fIl8gUKq2MwtoUlesQGeOc38R5PfJDgRu0UGCumrI12fqsjQFkAM5zDP/hJqEJYr4ZQgWJFAN7yGy4AFSamsZa3+AJcuQKzpsPnbAmAG6ylCBWJAG515XPVlLU4aTDXaH9QIkoQ599DUWtUxIJ4EYCN2rz48oitDBEaDQFsZkUA8Fl7SbIA2hHgoXLWY1vvAK7QEaI+8aPYJOFfrM8EQAbj7g6uMZtKx1kEAaBAReM7OHu79EKJUhuAFadtFhNnBzrjZ1ndtgQAdXD0GV+y41czEfhy8YgVvfR9G72DAOC5JZGyLYSG6PDaFlJNnJ1OXX5QP+QA6MErmLIAlvQ2AtzGOfDoRDkQEuEjAICFWGysd45gEA+RS0kEiF5DxNVTl8Pk8TrHQIU97FR4bCV0lrIVIqIV8mQrBJtJGL3vlokWjSNzlEfLJdUJgGry+GT6/oMZ4Hk+PNghdl3+W0xOqM63UHX4ADreep5s9pNOB5ZpJFE/wLYeDfDN8D6Cm/Dz4tMs9KDoREA9fb9cQEEnh5OeOO1eeQd9bXUAFAsoxEtYHBxB40iHR8MdHu3y5sdCTD0WynE3BChZwkIuIqKxDknPpXwREb0Q9LYDkGmCSpZxiRbSoSZXPwRgW76QjlzKqDQEzAwDVSxlJBeT8vDMbq3jt6fUzysXk0qW8zLV/+zAcl7xgmpqgv7rnx1cUC1a0s5XETADEvjwknbxooJGElD67eCigsmyjsVMNkC/zrKO8cKaKQEzhEAsS6mxsGZmaVNmUvupv7Rpurgs5ezwCYxT6a+xuGy8vC8eLGWGNJ/1lvfNLLBMDah96H7rLrCcLHEt9tB6RqDSPvWWuM4sMl44Unt6+bcNFhnPLvNe3MM6oXkaL/Mug5BBoP2M3WL5pforACIENJIdJmcCTjlys3GF+mr51QAycO5EMJCweOa4syvKqE+E+om7qHCPBkBE7+4mY8uybQ/ODYS+dgn8oGaBD4VwmsG2LWs82bmLA7WvAyCG2PKv6+52k/v5/H/f/+mqfJ/P7ye7neuu9n76OAD5RavFiYvub5I633hzc/P+4/Pzi6L8fPnZQnl+fn7/981Nnfoii9+8/AH4A/D/DvAvQSLsTa8i55oAAAAASUVORK5CYII=";

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export interface McpIconDescriptor {
  src: string;
  mimeType: string;
  sizes: string[];
}

function encodeSvgDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export const BRAND_DATA_URI_ICONS: McpIconDescriptor[] = [
  { src: encodeSvgDataUri(BRAND_ICON_SVG), mimeType: 'image/svg+xml', sizes: ['any'] },
  { src: `data:image/png;base64,${ICON_192_PNG_B64}`, mimeType: 'image/png', sizes: ['192x192'] },
  { src: `data:image/png;base64,${ICON_180_PNG_B64}`, mimeType: 'image/png', sizes: ['180x180'] },
];

export function brandIconsForOrigin(origin: string): McpIconDescriptor[] {
  const base = origin.replace(/\/+$/, '');
  return [
    { src: `${base}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: `${base}/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
    { src: `${base}/apple-touch-icon.png`, mimeType: 'image/png', sizes: ['180x180'] },
  ];
}

const ICON_HEADERS_BASE: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'public, max-age=86400',
  'X-Content-Type-Options': 'nosniff',
};

export function serveBrandIconRoute(pathname: string, method: string): Response | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const clean = pathname.toLowerCase();
  if (clean === '/favicon.svg' || clean === '/icon.svg') {
    return new Response(method === 'HEAD' ? null : BRAND_ICON_SVG, {
      status: 200,
      headers: { ...ICON_HEADERS_BASE, 'Content-Type': 'image/svg+xml; charset=utf-8' },
    });
  }
  if (clean === '/favicon.ico') {
    return new Response(method === 'HEAD' ? null : decodeBase64(FAVICON_ICO_B64), {
      status: 200,
      headers: { ...ICON_HEADERS_BASE, 'Content-Type': 'image/x-icon' },
    });
  }
  if (clean === '/icon-192.png' || clean === '/favicon.png' || clean === '/icon.png') {
    return new Response(method === 'HEAD' ? null : decodeBase64(ICON_192_PNG_B64), {
      status: 200,
      headers: { ...ICON_HEADERS_BASE, 'Content-Type': 'image/png' },
    });
  }
  if (clean === '/apple-touch-icon.png' || clean === '/apple-touch-icon-precomposed.png') {
    return new Response(method === 'HEAD' ? null : decodeBase64(ICON_180_PNG_B64), {
      status: 200,
      headers: { ...ICON_HEADERS_BASE, 'Content-Type': 'image/png' },
    });
  }
  return null;
}
