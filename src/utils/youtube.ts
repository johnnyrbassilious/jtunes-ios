const YT_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeVideoId(url: string, fallbackId?: string): string | null {
  if (url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host.includes('youtu.be')) {
        const candidate = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
        if (YT_ID_REGEX.test(candidate)) {
          return candidate;
        }
      }
      if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
        const vParam = parsed.searchParams.get('v') ?? '';
        if (YT_ID_REGEX.test(vParam)) {
          return vParam;
        }
        const segments = parsed.pathname.split('/').filter(Boolean);
        for (const seg of segments) {
          if (YT_ID_REGEX.test(seg)) {
            return seg;
          }
        }
      }
    } catch {
      // Fallback regex below
    }

    const match =
      /(?:v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i.exec(
        url
      );
    if (match && YT_ID_REGEX.test(match[1])) {
      return match[1];
    }
  }

  if (fallbackId && YT_ID_REGEX.test(fallbackId)) {
    return fallbackId;
  }

  return null;
}
