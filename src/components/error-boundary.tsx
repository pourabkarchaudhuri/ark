import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });
    
    // In production, you might want to send this to an error reporting service
    if (import.meta.env.PROD) {
      // Example: sendToErrorReportingService(error, errorInfo);
    }
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <Card className="max-w-lg w-full">
            <CardHeader>
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-full bg-red-500/10">
                  <AlertTriangle className="h-8 w-8 text-red-500" />
                </div>
                <div>
                  <CardTitle className="text-xl">Something went wrong</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    An unexpected error occurred in the application.
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {import.meta.env.DEV && this.state.error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  <p className="text-sm font-mono text-red-400 break-all">
                    {this.state.error.message}
                  </p>
                  {this.state.errorInfo && (
                    <details className="mt-2">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                        View stack trace
                      </summary>
                      <pre className="mt-2 text-xs text-muted-foreground overflow-auto max-h-40 whitespace-pre-wrap">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={this.handleReset}
                >
                  <Home className="h-4 w-4 mr-2" />
                  Try Again
                </Button>
                <Button className="flex-1" onClick={this.handleReload}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reload App
                </Button>
              </div>

              <p className="text-xs text-center text-muted-foreground">
                If this problem persists, please restart the application.
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

