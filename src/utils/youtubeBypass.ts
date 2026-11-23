import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

export interface StreamInfo {
  url: string;
  mime: string;
  quality?: string;
}

/**
 * Bypasses YouTube's DASH restrictions by fetching a pre-merged MP4
 * via CapacitorHttp (bypasses WKWebView CORS on iOS) through a
 * third-party resolver, then falling back to a simple InnerTube probe.
 */
export async function resolveYouTubeStream(videoId: string): Promise<StreamInfo | null> {
  // Only attempt on native; in a browser the InnerTube path in PlayerContext handles it.
  if (!Capacitor.isNativePlatform()) return null;

  try {
    // Use CapacitorHttp so the request goes through the native HTTP stack
    // (not WKWebView's restricted fetch) and avoids iOS CORS blocks.
    const response = await CapacitorHttp.get({
      url: `https://api.vevioz.com/api/video/resolver?id=${videoId}`,
      headers: { 'Accept': 'application/json' },
    });
    if (response.status >= 200 && response.status < 300) {
      const data =
        typeof response.data === 'string'
          ? (JSON.parse(response.data) as Record<string, unknown>)
          : (response.data as Record<string, unknown>);
      const urls = data.urls as Record<string, string> | undefined;
      if (data.status === 'success' && typeof urls?.mp4 === 'string') {
        return { url: urls.mp4, mime: 'video/mp4', quality: 'max' };
      }
    }
  } catch {
    // Fall through to null — PlayerContext will try InnerTube profiles next.
  }
  return null;
}

/**
 * Downloads the stream directly to the device storage.
 */
export async function downloadTrack(trackId: string, streamUrl: string, title: string): Promise<string> {
  try {
    const response = await fetch(streamUrl);
    const blob = await response.blob();

    // Sanitize filename
    const safeName = `${title.replace(/[^a-z0-9]/gi, '_')}.mp4`;
    const fileName = `${trackId}_${safeName}`;

    if (Capacitor.isNativePlatform()) {
      // Save to the Downloads directory via @capacitor/filesystem
      await Filesystem.writeFile({
        path: fileName,
        data: await blobToBase64(blob),
        directory: Directory.Downloads,
      });
      // Persist the saved path in localStorage (no @capacitor/storage needed)
      try {
        window.localStorage.setItem(`download_path_${trackId}`, `/downloads/${fileName}`);
      } catch {
        // Ignore storage errors
      }
      return `/downloads/${fileName}`;
    } else {
      // Web fallback: trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName;
      a.click();
      URL.revokeObjectURL(url);
      return url;
    }
  } catch (error) {
    console.error('Download failed:', error);
    throw new Error('Failed to download track');
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
