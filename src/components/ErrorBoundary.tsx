import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
  info: string | null;
}

// Without this, a render-time throw anywhere in the tree (a bad import, a
// crash in a new page component, etc.) unmounts the ENTIRE app with no
// visible trace - React just stops, and the near-black dark-mode body
// background (see src/index.css `prefers-color-scheme: dark`) makes that
// failure look exactly like "a completely black screen" instead of an
// obvious error. This boundary guarantees any future crash renders visibly
// on a light background with the actual error message and component
// stack, so the exact file/line is on screen instead of hidden in
// DevTools console (which isn't always open, especially in a packaged
// Electron build).
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
    this.setState({ info: info.componentStack || null });
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh",
          background: "#fff5f5",
          color: "#7f1d1d",
          fontFamily: "monospace",
          padding: 24,
          overflow: "auto",
        }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
            The app crashed while rendering
          </h1>
          <p style={{ marginBottom: 8 }}><strong>Message:</strong> {this.state.error.message}</p>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginBottom: 16 }}>{this.state.error.stack}</pre>
          {this.state.info ? (
            <>
              <p style={{ marginBottom: 8 }}><strong>Component stack:</strong></p>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{this.state.info}</pre>
            </>
          ) : null}
        </div>
      );
    }

    return this.props.children;
  }
}
