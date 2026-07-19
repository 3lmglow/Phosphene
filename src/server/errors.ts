export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function assertFound<T>(value: T | undefined | null, message = "Resource not found"): T {
  if (value == null) throw new AppError(404, "not_found", message);
  return value;
}

export function assertState(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(409, code, message);
}
