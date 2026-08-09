import React from 'react'

interface State {
  error: Error | null
}

/**
 * Without this, a render-phase exception anywhere in the tree unmounts the
 * whole app silently — and because the window is `transparent: true` with a
 * fully-transparent `backgroundColor`, what's left behind is a plain black
 * rectangle with no error, no text, nothing to act on. This turns that into
 * a visible message instead.
 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('renderer crashed', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-8 text-center text-text">
        <h1 className="text-lg font-semibold">Что-то сломалось</h1>
        <p className="max-w-md text-sm text-text-dim">{this.state.error.message}</p>
        <button
          className="mt-2 rounded-[10px] border border-line px-4 py-2 text-sm hover:bg-bg-hover"
          onClick={() => this.setState({ error: null })}
        >
          Попробовать снова
        </button>
      </div>
    )
  }
}
