/**
 * One JSON object per line on stdout. JSON escaping turns newlines and control
 * characters inside attacker-supplied values into plain escapes, so one request can
 * never forge a second log line.
 */
export function writeLog(record: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}
