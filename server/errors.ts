export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(kind = '资源'): never {
  throw new HttpError(404, 'NOT_FOUND', `${kind}不存在或已删除。`);
}

export function invalid(message: string): never {
  throw new HttpError(400, 'VALIDATION_ERROR', message);
}
