import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode, forwardRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType, duration?: number) => void;
  removeToast: (id: string) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

const toastConfig: Record<ToastType, { icon: typeof CheckCircle; className: string }> = {
  success: {
    icon: CheckCircle,
    className: 'bg-green-500/10 border-green-500/30 text-green-400',
  },
  error: {
    icon: AlertCircle,
    className: 'bg-red-500/10 border-red-500/30 text-red-400',
  },
  info: {
    icon: Info,
    className: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
  },
  warning: {
    icon: AlertTriangle,
    className: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
  },
};

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutRefs = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Cleanup all timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach((timeout) => clearTimeout(timeout));
      timeoutRefs.current.clear();
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    // Clear the timeout for this toast if it exists
    const timeout = timeoutRefs.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timeoutRefs.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = 'info', duration: number = 3000) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newToast: Toast = { id, message, type, duration };

      setToasts((prev) => [...prev, newToast]);

      if (duration > 0) {
        const timeout = setTimeout(() => {
          timeoutRefs.current.delete(id);
          setToasts((prev) => prev.filter((toast) => toast.id !== id));
        }, duration);
        timeoutRefs.current.set(id, timeout);
      }
    },
    []
  );

  const success = useCallback((message: string, duration?: number) => addToast(message, 'success', duration), [addToast]);
  const error = useCallback((message: string, duration?: number) => addToast(message, 'error', duration), [addToast]);
  const info = useCallback((message: string, duration?: number) => addToast(message, 'info', duration), [addToast]);
  const warning = useCallback((message: string, duration?: number) => addToast(message, 'warning', duration), [addToast]);

  return (
    <ToastContext.Provider
      value={{ toasts, addToast, removeToast, success, error, info, warning }}
    >
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="true"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
        ))}
      </AnimatePresence>
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

const ToastItem = forwardRef<HTMLDivElement, ToastItemProps>(({ toast, onRemove }, ref) => {
  const config = toastConfig[toast.type];
  const Icon = config.icon;

  return (
    <motion.div
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 100, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm shadow-lg min-w-[300px] max-w-[400px]',
        config.className
      )}
      role="status"
    >
      <Icon className="h-5 w-5 flex-shrink-0" />
      <span className="flex-1 text-sm font-medium text-foreground">{toast.message}</span>
      <button
        onClick={() => onRemove(toast.id)}
        className="p-1 rounded-md hover:bg-white/10 transition-colors"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" />
      </button>
    </motion.div>
  );
});

ToastItem.displayName = 'ToastItem';

