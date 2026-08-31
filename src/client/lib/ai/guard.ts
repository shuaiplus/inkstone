export const SHORT_OUTPUT_RATIO = 0.5
export const SHORT_OUTPUT_MIN_INPUT = 200

export interface LossReport {
  kind: 'truncated' | 'short'
  ratio?: number
}

export interface LossInput {
  input: string
  output: string
  finishReason: string | null
  isFirstTurn: boolean
}

export function detectLoss({ input, output, finishReason, isFirstTurn }: LossInput): LossReport | null {
  if (finishReason === 'length') return { kind: 'truncated' }
  if (!isFirstTurn) return null
  const inputLength = input.length
  const outputLength = output.length
  if (inputLength < SHORT_OUTPUT_MIN_INPUT) return null
  if (outputLength < inputLength * SHORT_OUTPUT_RATIO) {
    return { kind: 'short', ratio: inputLength ? outputLength / inputLength : 0 }
  }
  return null
}

export function splitForChunking(text: string, limit: number): string[] {
  const source = text ?? ''
  const max = Number(limit) || 0
  if (max <= 0 || source.length <= max) return source ? [source] : []

  const hardSlice = (run: string): string[] => {
    const pieces: string[] = []
    for (let index = 0; index < run.length; index += max) pieces.push(run.slice(index, index + max))
    return pieces
  }

  const pack = (units: string[], separator: string, split: (unit: string) => string[]): string[] => {
    const packed: string[] = []
    let current = ''
    for (const unit of units) {
      if (unit.length > max) {
        if (current) {
          packed.push(current)
          current = ''
        }
        for (const piece of split(unit)) packed.push(piece)
        continue
      }
      const next = current ? current + separator + unit : unit
      if (next.length > max) {
        packed.push(current)
        current = unit
      } else {
        current = next
      }
    }
    if (current) packed.push(current)
    return packed
  }

  const byLines = (paragraph: string): string[] => pack(paragraph.split('\n'), '\n', hardSlice)

  return pack(source.split(/\n{2,}/), '\n\n', byLines).filter((piece) => piece.trim())
}
