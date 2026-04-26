/**
 * Client-side upload helper. Uses XHR (instead of fetch) so we get real
 * progress events for the Composer's progress bar.
 */

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface UploadedAttachment {
  id: string;
  task_id: string | null;
  original_name: string;
  mime: string;
  kind: "image" | "document" | "spreadsheet" | "code" | "text" | "audio" | "video" | "other";
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  extraction_status: "pending" | "done" | "skipped" | "failed";
  extraction_error: string | null;
  extraction_chars: number;
  has_thumbnail: boolean;
  created_at: string;
}

const UPLOAD_URL = `${import.meta.env.BASE_URL}api/uploads`;

export function uploadFile(
  file: File,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file, file.name);

    xhr.open("POST", UPLOAD_URL);
    xhr.withCredentials = true;

    xhr.upload.addEventListener("progress", (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress({
        loaded: e.loaded,
        total: e.total,
        percent: Math.round((e.loaded / e.total) * 100),
      });
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedAttachment);
        } catch (e) {
          reject(new Error("Server returned invalid JSON"));
        }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          if (xhr.responseText) msg = xhr.responseText.slice(0, 200);
        }
        reject(new Error(msg));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload aborted", "AbortError")));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort());
    }

    xhr.send(form);
  });
}

export async function deleteAttachment(id: string): Promise<void> {
  const res = await fetch(`${UPLOAD_URL}/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}

export function thumbnailUrl(id: string): string {
  return `${UPLOAD_URL}/${id}/thumbnail`;
}

export function rawUrl(id: string): string {
  return `${UPLOAD_URL}/${id}/raw`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
