import { ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Button } from '@/components/ui/button';

/**
 * Isolates a single dashboard view (e.g. Voyage/OCD, DevLogs) so an error there
 * shows a contained, recoverable message instead of tearing down the whole
 * dashboard. Remounting via `resetKey` clears the error when the user navigates.
 */
export function ViewErrorBoundary({
  children,
  label,
  onBack,
  resetKey,
}: {
  children: ReactNode;
  label?: string;
  onBack?: () => void;
  resetKey?: string | number;
}) {
  const fallback = (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
      <div className="p-3 rounded-full bg-amber-500/10">
        <AlertTriangle className="h-7 w-7 text-amber-400" />
      </div>
      <div>
        <p className="text-white/80 font-medium">
          {label ? `The ${label} view ran into a problem` : 'This view ran into a problem'}
        </p>
        <p className="text-sm text-white/40 mt-1 max-w-md">
          The rest of the app is unaffected. Try going back, or reload if it persists.
        </p>
      </div>
      <div className="flex gap-3">
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        )}
        <Button size="sm" onClick={() => window.location.reload()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Reload
        </Button>
      </div>
    </div>
  );

  return (
    <ErrorBoundary key={resetKey} fallback={fallback}>
      {children}
    </ErrorBoundary>
  );
}
