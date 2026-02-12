import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { 
  Search, 
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
    icon: Search, // Not used for 'no-games' (caveman GIF is used instead)
    title: "No Games in Library",
    description: "Your game library is empty. Start building your collection by adding your first game!",
    actionLabel: "Browse Games",
    iconColor: "text-fuchsia-500",
    glowColor: "shadow-fuchsia-500/20",
  },
};

// ─── Caveman Empty State ──────────────────────────────────────────────────────
// Fun animated caveman GIF for the empty library state.
const CAVEMAN_GIF = 'https://cdn.dribbble.com/users/285475/screenshots/2083086/dribbble_1.gif';

// Electrocution puns — the caveman is getting zapped, and the app is "Arc".
// One random message is picked each time the component mounts.
const CAVEMAN_MESSAGES = [
  "Looks like the Arc lost power.",
  "How shocking!",
  "This library is… sparking empty.",
  "No games? That hertz.",
  "Watt happened to your collection?",
  "Ohm my… no games found.",
  "Current status: empty.",
  "Zero resistance to adding games.",
  "This is a high-voltage situation.",
  "Amp up your library!",
  "Looks like someone blew a fuse.",
  "Your library needs a recharge.",
  "Static. Just static.",
  "Disconnected from the grid.",
  "Power outage in your library.",
  "Voltage detected. Games not detected.",
  "Short circuit. Long library.",
  "Grounded. Literally.",
  "The circuit is complete. The library isn't.",
  "Conducting a search… found nothing.",
  "Positive charge, negative games.",
  "Plug in some games already.",
  "Arc reactor: online. Games: offline.",
  "You've been… discharged.",
  "Charged up, but nothing to play.",
  "Electrifying emptiness.",
  "Switch it on. Add some games.",
  "Running on empty current.",
  "This shelf has zero joules.",
];

function CavemanEmptyState({ onAction, className }: { onAction?: () => void; className?: string }) {
  const config = emptyStateConfig['no-games'];
  const [showText, setShowText] = useState(false);

  // Pick one random message per mount
  const [message] = useState(
    () => CAVEMAN_MESSAGES[Math.floor(Math.random() * CAVEMAN_MESSAGES.length)],
  );

  // Show text + button after 3 seconds
  useEffect(() => {
    const timer = setTimeout(() => setShowText(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={cn(
        "flex flex-col items-center justify-center px-4 min-h-[calc(100vh-10rem)]",
        className
      )}
    >
      {/* Caveman Animation — appears immediately */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 150, damping: 20, delay: 0.1 }}
        className="relative mb-2"
      >
        {/* Glow behind the image */}
        <div className="absolute inset-0 blur-3xl opacity-20 bg-fuchsia-500 rounded-full scale-75" />

        <div
          className="relative w-[680px] h-[520px] rounded-2xl overflow-hidden bg-center bg-no-repeat bg-contain mix-blend-screen"
          style={{
            backgroundImage: `url(${CAVEMAN_GIF})`,
            filter: 'invert(1) hue-rotate(180deg)',
          }}
          role="img"
          aria-label="Animated caveman getting electrocuted"
        />
      </motion.div>

      {/* Text + button — fades in after 3 seconds */}
      <AnimatePresence>
        {showText && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="text-center max-w-md"
          >
            {/* Random pun — one per visit */}
            <p className="text-lg font-semibold text-fuchsia-400 italic mb-2">
              {message}
            </p>

            <p className="text-white/50 text-sm leading-relaxed mb-6">
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
                  className="gap-2 px-6 bg-fuchsia-500 hover:bg-fuchsia-600 text-white"
                >
                  <Plus className="w-4 h-4" />
                  {config.actionLabel}
                </Button>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Default Icon Empty State ─────────────────────────────────────────────────
// Used for search / filter empty states (non-library).

function IconEmptyState({ type, onAction, className }: EmptyStateProps) {
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
              className="gap-2 px-6 bg-white/10 hover:bg-white/20 text-white border border-white/10"
            >
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

// ─── Public Export ─────────────────────────────────────────────────────────────
// Routes to the caveman animation for 'no-games' (library), icon style for others.

export function EmptyState({ type, onAction, className }: EmptyStateProps) {
  if (type === 'no-games') {
    return <CavemanEmptyState onAction={onAction} className={className} />;
  }
  return <IconEmptyState type={type} onAction={onAction} className={className} />;
}
