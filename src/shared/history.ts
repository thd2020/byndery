// Command memory: the pieces shared by the renderer, which captures each
// command and its output from the terminal, and the main process, which
// stores and searches them.

export interface CommandRecord {
  command: string
  cwd: string
  exit: number | null
  startedAt: number
  durationMs: number
  output: string
  /** True when the start of the output had already left the scrollback. */
  truncated: boolean
  shell: string
  /** One id per terminal tab and app run, for the "this terminal" filter. */
  session: string
}

export interface HistoryEntry {
  id: number
  command: string
  cwd: string
  exit: number | null
  startedAt: number
  durationMs: number
  session: string
  host: string
  /** First line of the output, for the list. */
  preview: string
  outputBytes: number
}

export type HistoryScope = 'all' | 'workspace' | 'folder' | 'session'

export interface HistoryQuery {
  text: string
  scope: HistoryScope
  cwd?: string
  session?: string
  /** The folder byndery has open, for the "this workspace" scope. */
  root?: string
  failedOnly?: boolean
  limit?: number
}

/** Decodes VS Code's OSC 633;E escaping: \\ is a backslash, \xNN a byte. */
export function unescapeCommandLine(s: string): string {
  return s.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, all: string, hex?: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : all
  )
}

// Shapes of credentials that should never be written to disk. The list
// follows the provider formats Atuin's secrets filter recognises, plus
// private key blocks and password assignments.
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI and Anthropic keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}\b/g // JWTs
]
// key=value and --password value forms, where only the value is hidden.
const SECRET_ASSIGN =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth)[\w-]*\s*(?:=|:|\s)\s*)(["']?)([^\s"']{4,})\2/gi

export const REDACTED = '‹redacted›'

export function redact(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(SECRET_ASSIGN, (_m, key: string, q: string) => `${key}${q}${REDACTED}${q}`)
  return out
}

/** Keeps the first and last halves of long output, as Atuin does, with the gap marked. */
export function capOutput(text: string, max = 1024 * 1024): { text: string; capped: boolean } {
  if (text.length <= max) return { text, capped: false }
  const head = Math.floor(max / 2)
  const tail = max - head
  const dropped = text.length - head - tail
  return {
    text: `${text.slice(0, head)}\n… ${dropped.toLocaleString('en')} characters not kept …\n${text.slice(-tail)}`,
    capped: true
  }
}

// Commands whose whole purpose is to print a secret. They are remembered, but
// their output never is, whatever it looks like. The list is Atuin's.
const SECRET_PRINTERS = [
  /^\s*(?:sudo\s+)?printenv\b/,
  /^\s*(?:sudo\s+)?env\s*$/,
  /^\s*gh\s+auth\s+token\b/,
  /^\s*kubectl\s+get\s+secrets?\b/,
  /^\s*vault\s+(?:kv\s+)?(?:get|read)\b/,
  /^\s*op\s+read\b/,
  /^\s*aws\s+configure\s+get\b/,
  /^\s*(?:cat|type|bat|less|more|Get-Content|gc)\s+(?:\S*[\\/])?\.env(?:\.\S*)?\s*$/i,
  /^\s*(?:Get-ChildItem|gci|ls|dir)\s+env:/i
]

export function outputAllowed(command: string): boolean {
  return !SECRET_PRINTERS.some((re) => re.test(command))
}

/** Commands not worth remembering: empty ones, and ones typed with a leading space. */
export function shouldRemember(command: string): boolean {
  return command.trim().length > 0 && !/^\s/.test(command)
}
