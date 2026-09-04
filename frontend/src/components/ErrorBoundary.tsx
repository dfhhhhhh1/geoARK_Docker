import React from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Contains a render failure to one panel.
 *
 * Written after a real one: a legend built from the wrong array length called
 * toFixed on undefined, React unmounted the whole tree, and the page went
 * blank -- losing the analysis that had just taken 45 seconds to produce. A
 * broken chart should cost the chart, not the result.
 */
interface Props {
  children: React.ReactNode;
  /** What failed, named for the user: "the map", "the report". */
  label: string;
}

interface State {
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex gap-2 bg-amber-50 border border-amber-200 text-amber-900
                        rounded-lg p-4 text-sm">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Could not display {this.props.label}</p>
            <p className="mt-0.5 opacity-90">{this.state.error.message}</p>
            <p className="mt-1 opacity-75">
              The rest of the analysis below is unaffected.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
