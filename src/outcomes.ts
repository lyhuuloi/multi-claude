export const Exit = {
  ok: 0,
  failure: 1,
  findings: 2,
  usage: 64,
  unavailable: 69,
  refusal: 73,
  recovery: 74,
  interrupted: 130
} as const;
export class Problem extends Error {
  constructor(readonly kind: string, message: string, readonly status: number = Exit.refusal) {
    super(message);
  }
}
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
export function terminalText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,
    '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      '�');
}
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
