import pc from 'picocolors'

// A minimal spinner for the long (model-bound) steps. Writes to stderr so it
// never mixes into the report on stdout, and degrades to a single line when
// output isn't a TTY (CI) instead of spamming animation frames.

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface Spinner {
  update(text: string): void
  stop(final?: string): void
}

export function spin(text: string): Spinner {
  if (!process.stderr.isTTY) {
    process.stderr.write(text + '\n')
    return { update() {}, stop() {} }
  }
  let frame = 0
  let current = text
  const render = () => process.stderr.write(`\r${pc.cyan(FRAMES[frame = (frame + 1) % FRAMES.length]!)} ${current}\x1b[K`)
  const timer = setInterval(render, 80)
  render()
  return {
    update: t => { current = t },
    stop: final => {
      clearInterval(timer)
      process.stderr.write('\r\x1b[K')
      if (final) process.stderr.write(final + '\n')
    },
  }
}
