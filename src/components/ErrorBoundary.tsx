// src/components/ErrorBoundary.tsx
// Without this, any render error unmounts the whole React tree and the user sees a blank white page.
// With it, they see what happened and can retry. Pass `resetKey` (e.g. the route path) to recover on navigation.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./ui";

type Props = { children: ReactNode; resetKey?: string };
type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Page crashed:", error, info.componentStack); }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Card className="mx-auto my-10 max-w-md space-y-3 py-8 text-center">
        <p className="font-medium">Something went wrong on this page</p>
        <p className="text-sm text-muted">{error.message || "Unexpected error"}</p>
        <div className="flex justify-center gap-2">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </Card>
    );
  }
}
