// Subsequence matching for quick open, scored the way people expect from
// VS Code and fzf: consecutive characters, the start of a path segment and
// matches in the file name count most; long paths count against.

export interface FuzzyResult {
  item: string
  score: number
  /** Indices into item that matched, for highlighting. */
  hits: number[]
}

export function score(query: string, item: string): FuzzyResult | null {
  if (!query) return { item, score: 0, hits: [] }
  const q = query.toLowerCase().replace(/\\/g, '/')
  const s = item.toLowerCase()
  const nameStart = item.lastIndexOf('/') + 1
  const hits: number[] = []
  let total = 0
  let qi = 0
  let prev = -2
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (q[qi] === ' ') {
      qi++
      if (qi >= q.length) break
    }
    if (s[i] !== q[qi]) continue
    let pts = 1
    if (i === prev + 1) pts += 5
    const before = item[i - 1]
    if (i === 0 || before === '/' || before === '_' || before === '-' || before === '.' || before === ' ') pts += 8
    else if (item[i] >= 'A' && item[i] <= 'Z' && before >= 'a' && before <= 'z') pts += 6
    if (i >= nameStart) pts += 3
    total += pts
    hits.push(i)
    prev = i
    qi++
  }
  if (qi < q.length) return null
  // A query that matches the whole file name from its first letter wins outright.
  if (item.slice(nameStart).toLowerCase().startsWith(q)) total += 40
  total -= item.length * 0.05
  return { item, score: total, hits }
}

export function rank(query: string, items: string[], limit = 60): FuzzyResult[] {
  const out: FuzzyResult[] = []
  for (const it of items) {
    const r = score(query, it)
    if (r) out.push(r)
  }
  out.sort((a, b) => b.score - a.score || a.item.length - b.item.length)
  return out.slice(0, limit)
}
