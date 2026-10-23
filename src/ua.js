// Tiny user-agent parser: good enough for analytics charts, no dependency needed
export function parseUserAgent(ua = "") {
  const s = ua.toLowerCase();
  const bot = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python-requests|httpclient/.test(s);

  const browser =
    /edg\//.test(s) ? "Edge" :
    /opr\/|opera/.test(s) ? "Opera" :
    /samsungbrowser/.test(s) ? "Samsung Internet" :
    /firefox|fxios/.test(s) ? "Firefox" :
    /chrome|crios/.test(s) ? "Chrome" :
    /safari/.test(s) ? "Safari" :
    "Other";

  const os =
    /windows/.test(s) ? "Windows" :
    /iphone|ipad|ipod/.test(s) ? "iOS" :
    /android/.test(s) ? "Android" :
    /mac os x|macintosh/.test(s) ? "macOS" :
    /cros/.test(s) ? "ChromeOS" :
    /linux/.test(s) ? "Linux" :
    "Other";

  const device = /ipad|tablet/.test(s) ? "Tablet" : /mobi|iphone|android/.test(s) ? "Mobile" : "Desktop";

  return { bot, browser, os, device };
}

export function referrerName(header, selfHost) {
  if (!header) return "Direct";
  try {
    const host = new URL(header).hostname.replace(/^www\./, "");
    if (!host || host === selfHost) return "Direct";
    return host;
  } catch {
    return "Direct";
  }
}
