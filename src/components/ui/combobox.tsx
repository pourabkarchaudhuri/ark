import * as React from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';

interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** When true, uses smaller trigger/content (text-[10px], h-6 input, compact list items) to match compact Selects. */
  compact?: boolean;
}

export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = 'Select option...',
  searchPlaceholder = 'Search...',
  emptyMessage = 'No option found.',
  className,
  disabled,
  'aria-label': ariaLabel,
  compact,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');

  const filteredOptions = React.useMemo(() => {
    if (!searchQuery) return options;
    const query = searchQuery.toLowerCase();
    return options.filter((option) =>
      option.label.toLowerCase().includes(query)
    );
  }, [options, searchQuery]);

  const selectedOption = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'w-full justify-between bg-background/50',
            !value && 'text-muted-foreground',
            className
          )}
        >
          {selectedOption?.label || placeholder}
          <ChevronsUpDown className={cn('shrink-0 opacity-50', compact ? 'ml-1 h-3 w-3' : 'ml-2 h-4 w-4')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(compact ? 'w-[200px] p-0' : 'w-[280px] p-0')}
        align="start"
      >
        <div className={cn('border-b border-white/10', compact ? 'p-1.5' : 'p-2')}>
          <div className="relative">
            <Search className={cn('absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground', compact ? 'h-3 w-3' : 'h-4 w-4')} />
            <Input
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={cn(
                'pl-8 bg-transparent border-white/10',
                compact ? 'h-6 text-[10px]' : 'h-8'
              )}
            />
          </div>
        </div>
        <div className={cn('overflow-y-auto', compact ? 'max-h-48 p-0.5' : 'max-h-60 p-1')}>
          {filteredOptions.length === 0 ? (
            <p className={cn('py-4 text-center text-muted-foreground', compact ? 'text-[10px]' : 'text-sm')}>
              {emptyMessage}
            </p>
          ) : (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  onValueChange(option.value);
                  setOpen(false);
                  setSearchQuery('');
                }}
                className={cn(
                  'w-full flex items-center gap-2 rounded-sm text-left hover:bg-white/10 transition-colors',
                  compact ? 'px-2 py-1 text-[10px]' : 'px-2 py-1.5 text-sm',
                  value === option.value && 'bg-fuchsia-500/20'
                )}
              >
                <Check
                  className={cn(
                    value === option.value ? 'opacity-100' : 'opacity-0',
                    compact ? 'h-3 w-3' : 'h-4 w-4'
                  )}
                />
                {option.label}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

