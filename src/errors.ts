export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CORRUPTION"
  | "CONFIG"
  | "UNAUTHORIZED";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CORRUPTION: 500,
  CONFIG: 500,
  UNAUTHORIZED: 401,
};

export class AllocationError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AllocationError";
    this.code = code;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function isAllocationError(value: unknown): value is AllocationError {
  return value instanceof AllocationError;
}
