const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
  /\b([A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*[:=]\s*)[^\s,'"\\]+/gi,
  /\b([A-Za-z0-9_]*AUTH[_-]?TOKEN[A-Za-z0-9_]*\s*[:=]\s*)[^\s,'"\\]+/gi,
  /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...args: string[]) => {
      const match = args[0];
      const prefix = args.length > 2 ? args[1] : undefined;
      return prefix && match.startsWith(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]";
    });
  }
  return redacted;
}
