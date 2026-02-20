"use client";

import React from "react";
import { motion } from "framer-motion";
import { Folder, HeartHandshake, Sparkles, User } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DatabaseWithRestApiProps {
  className?: string;
  circleText?: string;
  circleIcon?: React.ReactNode;
  badgeTexts?: {
    first: string;
    second: string;
    third: string;
    fourth: string;
  };
  buttonTexts?: {
    first: string;
    second: string;
  };
  title?: string;
  lightColor?: string;
}

const DatabaseWithRestApi = ({
  className,
  circleText,
  circleIcon,
  badgeTexts,
  buttonTexts,
  title,
  lightColor,
}: DatabaseWithRestApiProps) => {
  return (
    <div
      className={cn(
        "relative flex w-full max-w-[500px] flex-1 flex-col items-center min-w-0 min-h-0",
        className
      )}
    >
      <svg
        className="h-full sm:w-full text-muted-foreground flex-shrink"
        width="100%"
        height="100%"
        viewBox="0 0 200 100"
        preserveAspectRatio="xMidYMid meet"
      >
        <g
          stroke="currentColor"
          fill="none"
          strokeWidth="0.4"
          strokeDasharray="100 100"
          pathLength={100}
        >
          <path d="M 31 10 v 15 q 0 5 5 5 h 59 q 5 0 5 5 v 10" />
          <path d="M 77 10 v 10 q 0 5 5 5 h 13 q 5 0 5 5 v 10" />
          <path d="M 124 10 v 10 q 0 5 -5 5 h -14 q -5 0 -5 5 v 10" />
          <path d="M 170 10 v 15 q 0 5 -5 5 h -60 q -5 0 -5 5 v 10" />
          <animate
            attributeName="stroke-dashoffset"
            from="100"
            to="0"
            dur="1s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.25,0.1,0.5,1"
            keyTimes="0; 1"
          />
        </g>
        <g mask="url(#db-mask-1)">
          <circle
            className="database db-light-1"
            cx="0"
            cy="0"
            r="12"
            fill="url(#db-blue-grad)"
          />
        </g>
        <g mask="url(#db-mask-2)">
          <circle
            className="database db-light-2"
            cx="0"
            cy="0"
            r="12"
            fill="url(#db-blue-grad)"
          />
        </g>
        <g mask="url(#db-mask-3)">
          <circle
            className="database db-light-3"
            cx="0"
            cy="0"
            r="12"
            fill="url(#db-blue-grad)"
          />
        </g>
        <g mask="url(#db-mask-4)">
          <circle
            className="database db-light-4"
            cx="0"
            cy="0"
            r="12"
            fill="url(#db-blue-grad)"
          />
        </g>
        <g stroke="currentColor" fill="none" strokeWidth="0.4">
          <g>
            <rect fill="#18181B" x="14" y="5" width="34" height="10" rx="5" />
            <DatabaseIcon x="18" y="7.5" />
            <text x="28" y="12" fill="white" stroke="none" fontSize="4.5" fontWeight="500">
              {badgeTexts?.first ?? "Library"}
            </text>
          </g>
          <g>
            <rect fill="#18181B" x="60" y="5" width="34" height="10" rx="5" />
            <DatabaseIcon x="64" y="7.5" />
            <text x="74" y="12" fill="white" stroke="none" fontSize="4.5" fontWeight="500">
              {badgeTexts?.second ?? "Sessions"}
            </text>
          </g>
          <g>
            <rect fill="#18181B" x="108" y="5" width="34" height="10" rx="5" />
            <DatabaseIcon x="112" y="7.5" />
            <text x="122" y="12" fill="white" stroke="none" fontSize="4.5" fontWeight="500">
              {badgeTexts?.third ?? "History"}
            </text>
          </g>
          <g>
            <rect fill="#18181B" x="150" y="5" width="40" height="10" rx="5" />
            <DatabaseIcon x="154" y="7.5" />
            <text x="165" y="12" fill="white" stroke="none" fontSize="4.5" fontWeight="500">
              {badgeTexts?.fourth ?? "Ratings"}
            </text>
          </g>
        </g>
        <defs>
          <mask id="db-mask-1">
            <path
              d="M 31 10 v 15 q 0 5 5 5 h 59 q 5 0 5 5 v 10"
              strokeWidth="0.5"
              stroke="white"
            />
          </mask>
          <mask id="db-mask-2">
            <path
              d="M 77 10 v 10 q 0 5 5 5 h 13 q 5 0 5 5 v 10"
              strokeWidth="0.5"
              stroke="white"
            />
          </mask>
          <mask id="db-mask-3">
            <path
              d="M 124 10 v 10 q 0 5 -5 5 h -14 q -5 0 -5 5 v 10"
              strokeWidth="0.5"
              stroke="white"
            />
          </mask>
          <mask id="db-mask-4">
            <path
              d="M 170 10 v 15 q 0 5 -5 5 h -60 q -5 0 -5 5 v 10"
              strokeWidth="0.5"
              stroke="white"
            />
          </mask>
          <radialGradient id="db-blue-grad" fx="1">
            <stop offset="0%" stopColor={lightColor ?? "#00d4ff"} />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
      </svg>
      <div className="absolute bottom-6 flex w-full flex-col items-center min-w-0">
        <div className="absolute -bottom-3 h-[70px] w-[62%] rounded-lg bg-accent/30" />
        <div className="absolute -top-3 z-20 flex items-center justify-center rounded-lg border bg-[#101112] px-2 py-1 max-w-[95%] min-w-0">
          <Sparkles className="size-3 flex-shrink-0" />
          <span className="ml-1.5 text-xs truncate" title={title ?? "Taste DNA from your activity"}>
            {title ?? "Taste DNA from your activity"}
          </span>
        </div>
        <div className="absolute -bottom-6 z-30 grid h-[48px] w-[48px] place-items-center rounded-full border-t bg-[#141516] font-semibold text-xs text-white/80">
          {circleIcon ?? (circleText ? circleText : <User className="size-5" />)}
        </div>
        <div className="relative z-10 flex h-[110px] w-full items-center justify-center overflow-hidden rounded-lg border bg-background shadow-md min-w-0">
          <div className="absolute bottom-5 left-6 z-10 flex h-7 max-w-[50%] items-center gap-1.5 rounded-full border bg-[#101112] px-2.5 text-xs min-w-0">
            <HeartHandshake className="size-3.5 flex-shrink-0" />
            <span className="truncate">{buttonTexts?.first ?? "Genome"}</span>
          </div>
          <div className="absolute right-6 z-10 hidden h-7 max-w-[50%] items-center gap-1.5 rounded-full border bg-[#101112] px-2.5 text-xs sm:flex min-w-0">
            <Folder className="size-3.5 flex-shrink-0" />
            <span className="truncate">{buttonTexts?.second ?? "Taste DNA"}</span>
          </div>
          <motion.div
            className="absolute -bottom-10 h-[80px] w-[80px] rounded-full border-t bg-accent/5"
            animate={{ scale: [0.98, 1.02, 0.98, 1, 1, 1, 1, 1, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <motion.div
            className="absolute -bottom-14 h-[115px] w-[115px] rounded-full border-t bg-accent/5"
            animate={{ scale: [1, 1, 1, 0.98, 1.02, 0.98, 1, 1, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <motion.div
            className="absolute -bottom-[72px] h-[150px] w-[150px] rounded-full border-t bg-accent/5"
            animate={{ scale: [1, 1, 1, 1, 1, 0.98, 1.02, 0.98, 1, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <motion.div
            className="absolute -bottom-[90px] h-[185px] w-[185px] rounded-full border-t bg-accent/5"
            animate={{ scale: [1, 1, 1, 1, 1, 1, 0.98, 1.02, 0.98, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        </div>
      </div>
    </div>
  );
};

export default DatabaseWithRestApi;

function DatabaseIcon({ x, y }: { x: string; y: string }) {
  return (
    <svg
      x={x}
      y={y}
      xmlns="http://www.w3.org/2000/svg"
      width="5"
      height="5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  );
}
