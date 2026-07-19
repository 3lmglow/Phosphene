export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown
  ) {
    super(message);
  }
}

function csrfToken(): string | undefined {
  return document.cookie
    .split("; ")
    .find((item) => item.startsWith("phosphene_csrf="))
    ?.split("=")
    .slice(1)
    .join("=");
}

export async function api<T>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: BodyInit | Record<string, unknown> } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const csrf = csrfToken();
  if (csrf && options.method && !["GET", "HEAD"].includes(options.method)) {
    headers.set("x-csrf-token", decodeURIComponent(csrf));
  }
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers,
    body: body as BodyInit | undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new ApiError(
      payload?.error?.code ?? "request_failed",
      payload?.error?.message ?? "请求没有成功，请稍后再试。",
      response.status,
      payload?.error?.details
    );
  }
  return payload.data as T;
}

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
