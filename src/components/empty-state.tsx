import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { 
  Search, 
  Gamepad2, 
  Filter,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

type EmptyStateType = 'no-results' | 'no-games' | 'no-filter-results';

interface EmptyStateProps {
  type: EmptyStateType;
  onAction?: () => void;
  className?: string;
}

const emptyStateConfig: Record<EmptyStateType, {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  actionLabel?: string;
  iconColor: string;
  glowColor: string;
}> = {
  'no-results': {
    icon: Search,
    title: "No Games Found",
    description: "We couldn't find any games matching your search. Try different keywords or check your spelling.",
    actionLabel: "Clear Search",
    iconColor: "text-cyan-500",
    glowColor: "shadow-cyan-500/20",
  },
  'no-filter-results': {
    icon: Filter,
    title: "No Matching Games",
    description: "No games match your current filters. Try adjusting or clearing your filters to see more games.",
    actionLabel: "Clear Filters",
    iconColor: "text-yellow-500",
    glowColor: "shadow-yellow-500/20",
  },
  'no-games': {
    icon: Gamepad2,
    title: "No Games in Library",
    description: "Your game library is empty. Start building your collection by adding your first game!",
    actionLabel: "Add Your First Game",
    iconColor: "text-fuchsia-500",
    glowColor: "shadow-fuchsia-500/20",
  },
};

export function EmptyState({ type, onAction, className }: EmptyStateProps) {
  const config = emptyStateConfig[type];
  const Icon = config.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "flex flex-col items-center justify-center py-16 px-4",
        className
      )}
    >
      {/* Animated Icon Container */}
      <motion.div
        initial={{ scale: 0.8 }}
        animate={{ scale: 1 }}
        transition={{ 
          type: "spring",
          stiffness: 200,
          damping: 15,
          delay: 0.1 
        }}
        className="relative mb-8"
      >
        {/* Glow effect */}
        <div className={cn(
          "absolute inset-0 blur-3xl opacity-30 rounded-full",
          config.iconColor.replace('text-', 'bg-')
        )} />
        
        {/* Icon background */}
        <div className={cn(
          "relative w-32 h-32 rounded-full bg-white/5 backdrop-blur-sm border border-white/10 flex items-center justify-center",
          "shadow-2xl",
          config.glowColor
        )}>
          <Icon className={cn("w-16 h-16", config.iconColor)} />
        </div>

        {/* Animated rings */}
        <motion.div
          animate={{ 
            scale: [1, 1.2, 1],
            opacity: [0.3, 0.1, 0.3]
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: "easeInOut"
          }}
          className={cn(
            "absolute inset-0 rounded-full border",
            config.iconColor.replace('text-', 'border-').replace('500', '500/30')
          )}
        />
        <motion.div
          animate={{ 
            scale: [1, 1.4, 1],
            opacity: [0.2, 0.05, 0.2]
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: "easeInOut",
            delay: 0.5
          }}
          className={cn(
            "absolute inset-0 rounded-full border",
            config.iconColor.replace('text-', 'border-').replace('500', '500/20')
          )}
        />
      </motion.div>

      {/* Text content */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.4 }}
        className="text-center max-w-md"
      >
        <h3 className="text-2xl font-bold text-white mb-3 tracking-tight">
          {config.title}
        </h3>
        <p className="text-white/60 text-sm leading-relaxed mb-6">
          {config.description}
        </p>

        {config.actionLabel && onAction && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.3 }}
          >
            <Button
              onClick={onAction}
              className={cn(
                "gap-2 px-6",
                type === 'no-games' 
                  ? "bg-fuchsia-500 hover:bg-fuchsia-600 text-white" 
                  : "bg-white/10 hover:bg-white/20 text-white border border-white/10"
              )}
            >
              {type === 'no-games' && <Plus className="w-4 h-4" />}
              {config.actionLabel}
            </Button>
          </motion.div>
        )}
      </motion.div>

      {/* Decorative elements */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-1 h-1 bg-fuchsia-500/40 rounded-full animate-pulse" />
        <div className="absolute top-1/3 right-1/3 w-1 h-1 bg-cyan-500/40 rounded-full animate-pulse delay-300" />
        <div className="absolute bottom-1/4 left-1/3 w-1 h-1 bg-fuchsia-500/30 rounded-full animate-pulse delay-700" />
        <div className="absolute bottom-1/3 right-1/4 w-1 h-1 bg-cyan-500/30 rounded-full animate-pulse delay-500" />
      </div>
    </motion.div>
  );
}

