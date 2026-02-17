import { Component, Suspense, useState, useRef, useCallback, useEffect } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, OrbitControls, PerspectiveCamera, Stars } from '@react-three/drei';
import { Gamepad2 } from 'lucide-react';
import { WindowControls } from '@/components/window-controls';
import { APP_VERSION } from '@/components/changelog-modal';
import {
  getCachedBrowseData,
  prefetchBrowseData,
  isPrefetchReady,
} from '@/services/prefetch-store';
import { fetchAllNews } from '@/services/news-service';

// Preload the Dashboard chunk so it's already in memory when the user clicks
// "Enter Ark". Without this the browser has to fetch + parse the JS bundle
// on transition, adding a visible delay.
const _dashboardPreload = import('@/pages/dashboard');
import { MathUtils } from 'three';
import type { Group, AmbientLight, SpotLight } from 'three';

/* ------------------------------------------------------------------ */
/*  Error boundary — prevents a WebGL / Three.js crash from taking     */
/*  down the entire splash screen.  Falls back to a plain background.  */
/* ------------------------------------------------------------------ */

class CanvasErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[SplashScreen] 3D canvas failed — falling back to flat background', error, info);
  }

  render() {
    if (this.state.hasError) return null; // parent already has gradient bg
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/*  Boot sequence — fast line-by-line with randomized sub-tasks         */
/*                                                                      */
/*  Each section prints a command header, rapid-fires 3-4 sub-task      */
/*  lines with [  OK  ] status, then a spacer. Light values drive       */
/*  the 3D scene brightness as lines appear.                            */
/* ------------------------------------------------------------------ */

const _V = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.27';

/** Pick one random element from an array. */
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

interface BootLine {
  variants: string[];
  delay: number;   // ms to wait AFTER printing this line
  light: number;   // scene brightness (0–1) when this line appears
}

const BOOT_LINES: BootLine[] = [
  // ── Header ─────────────────────────────────────────────────────────
  { variants: ['$ ark --cold-boot', '$ ark --wake', '$ ark --ignition'], delay: 200, light: 0 },
  { variants: [''], delay: 50, light: 0 },
  { variants: [`ARK DEEP STORAGE RECOVERY v${_V}`], delay: 80, light: 0 },
  { variants: ['────────────────────────────────────────'], delay: 60, light: 0 },
  { variants: [''], delay: 40, light: 0 },

  // ── Section 1: Core systems (0→18%) ────────────────────────────────
  { variants: [
    '> Initialising core systems...',
    '> Powering up primary subsystems...',
    '> Engaging cold-start ignition sequence...',
  ], delay: 180, light: 0.02 },
  { variants: [
    '[  OK  ] Waking from cryo-sleep',
    '[  OK  ] Thawing primary cortex',
    '[  OK  ] Breaking hibernation seal',
  ], delay: 90, light: 0.05 },
  { variants: [
    '[  OK  ] Fusion core ignited',
    '[  OK  ] Main reactor spooling up',
    '[  OK  ] Power grid engaged',
  ], delay: 70, light: 0.09 },
  { variants: [
    '[  OK  ] Hull integrity verified — no breaches',
    '[  OK  ] Structural scan complete — hull intact',
    '[  OK  ] Outer shell holding — zero micro-fractures',
  ], delay: 60, light: 0.13 },
  { variants: [
    '[  OK  ] Life support nominal',
    '[  OK  ] Atmosphere processors stable',
    '[  OK  ] O₂ recyclers operational',
  ], delay: 50, light: 0.18 },
  { variants: [''], delay: 40, light: 0.18 },

  // ── Section 2: Memory / vault restoration (18→45%) ─────────────────
  { variants: [
    '> Restoring vault memory banks...',
    '> Spinning up deep-storage arrays...',
    '> Decrypting frozen archive sectors...',
  ], delay: 160, light: 0.20 },
  { variants: [
    '[  OK  ] Epoch timestamp recovered',
    '[  OK  ] Temporal index synchronised',
    '[  OK  ] Star-date calibration locked',
  ], delay: 70, light: 0.25 },
  { variants: [
    '[  OK  ] Game vault seals intact',
    '[  OK  ] Cryogenic game pods sealed',
    '[  OK  ] Data vault pressure nominal',
  ], delay: 60, light: 0.30 },
  { variants: [
    '[  OK  ] Library archives thawed',
    '[  OK  ] Collection manifests decoded',
    '[  OK  ] Title index rebuilt',
  ], delay: 55, light: 0.35 },
  { variants: [
    '[  OK  ] Voyage logs preserved',
    '[  OK  ] Captain\'s log intact',
    '[  OK  ] Voyage records recovered',
  ], delay: 50, light: 0.38 },
  { variants: [
    '[  OK  ] Session black box recovered',
    '[  OK  ] Activity telemetry restored',
    '[  OK  ] Flight recorder parsed',
  ], delay: 50, light: 0.45 },
  { variants: [''], delay: 40, light: 0.45 },

  // ── Section 3: Network uplink (45→72%) ─────────────────────────────
  { variants: [
    '> Re-establishing deep-space uplink...',
    '> Scanning for carrier signals...',
    '> Aligning subspace antenna array...',
  ], delay: 160, light: 0.48 },
  { variants: [
    '[  OK  ] Steam beacon — signal acquired',
    '[  OK  ] Steam relay — locked on',
    '[  OK  ] Steam transponder — ping 42ms',
  ], delay: 80, light: 0.55 },
  { variants: [
    '[  OK  ] Epic relay — handshake confirmed',
    '[  OK  ] Epic gateway — tunnel open',
    '[  OK  ] Epic subspace — channel clear',
  ], delay: 65, light: 0.62 },
  { variants: [
    '[  OK  ] Deep space cache — still warm',
    '[  OK  ] Proximity buffer synced',
    '[  OK  ] Orbital cache — no corruption',
  ], delay: 55, light: 0.68 },
  { variants: [
    '[  OK  ] Heartbeat established — 4ms jitter',
    '[  OK  ] Signal integrity nominal',
    '[  OK  ] Round-trip latency within bounds',
  ], delay: 50, light: 0.72 },
  { variants: [''], delay: 40, light: 0.72 },

  // ── Section 4: Final diagnostics (72→100%) ─────────────────────────
  { variants: [
    '> Running final diagnostics...',
    '> Executing pre-launch checks...',
    '> Performing system-wide validation...',
  ], delay: 150, light: 0.76 },
  { variants: [
    '[  OK  ] Subsystem checksums valid',
    '[  OK  ] Module hashes cross-referenced',
    '[  OK  ] Kernel signatures audited',
  ], delay: 70, light: 0.82 },
  { variants: [
    '[  OK  ] Memory bus stress test passed',
    '[  OK  ] I/O throughput nominal',
    '[  OK  ] Render pipeline profiled',
  ], delay: 60, light: 0.90 },
  { variants: [
    '[  OK  ] Navigation firmware certified',
    '[  OK  ] Heading calibration locked',
    '[  OK  ] Gyroscope drift within tolerance',
  ], delay: 50, light: 0.95 },
  { variants: [''], delay: 60, light: 0.95 },

  // ── Finale ─────────────────────────────────────────────────────────
  { variants: [
    '[  OK  ] All systems nominal — The Ark remembers everything',
    '[  OK  ] Diagnostics passed — Welcome back, Commander',
    '[  OK  ] Green across the board — The Ark awaits your command',
  ], delay: 100, light: 1.0 },
  { variants: [''], delay: 400, light: 1.0 },
];

/* ------------------------------------------------------------------ */
/*  Scene lights                                                        */
/*                                                                      */
/*  Driven by `progress` (0–1) that maps to the boot sequence.          */
/*  0.00–0.70 : gradual ramp — ambient leads, spot trails behind        */
/*  0.70–1.00 : flicker ignition — both lights stutter to full power    */
/*  The split between ambient/spot gives a cascading "circuits          */
/*  powering on" feel rather than a single switch.                      */
/* ------------------------------------------------------------------ */

/** Threshold where the dramatic flicker-ignition phase begins. */
const FLICKER_THRESHOLD = 0.72;

function SceneLights({ progress }: { progress: number }) {
  const ambientRef = useRef<AmbientLight>(null);
  const spotRef = useRef<SpotLight>(null);

  // Target intensities (match the original static values)
  const AMBIENT_TARGET = 0.75 * Math.PI;
  const SPOT_TARGET = 2.25 * Math.PI;

  // ── Flicker ignition state (the final push to 100%) ────────────
  const phaseRef = useRef<'ramp' | 'flicker' | 'on'>('ramp');
  const flickerStartRef = useRef(0);
  const prevProgressRef = useRef(0);

  type Keyframe = [time: number, brightness: number];

  // Ambient catches first — diffuse glow spreading through the Ark
  const AMBIENT_FLICKER: Keyframe[] = [
    [0.00, 0.00],
    [0.05, 0.55],   // initial surge from ramp level
    [0.12, 0.30],   // dips
    [0.22, 0.70],   // glow spreads
    [0.30, 0.45],   // wavers
    [0.40, 0.82],   // most of the way
    [0.48, 0.60],   // small dip
    [0.58, 0.90],   // nearly there
    [0.70, 0.95],   // settling
    [0.82, 1.00],   // full ambient
  ];

  // Spot kicks in later — the directional beam finding its mark
  const SPOT_FLICKER: Keyframe[] = [
    [0.00, 0.00],
    [0.08, 0.00],   // stays dark while ambient surges first
    [0.14, 0.25],   // first glimmer
    [0.20, 0.05],   // fades back
    [0.30, 0.45],   // stronger flash
    [0.36, 0.12],   // dies back
    [0.46, 0.60],   // catching
    [0.52, 0.30],   // dip
    [0.60, 0.75],   // almost locked
    [0.66, 0.50],   // last stutter
    [0.76, 0.88],   // beam stabilising
    [0.88, 1.00],   // full spot
  ];

  const FLICKER_DURATION = Math.max(
    AMBIENT_FLICKER[AMBIENT_FLICKER.length - 1][0],
    SPOT_FLICKER[SPOT_FLICKER.length - 1][0],
  );

  /** Smooth-step sample through a keyframe array. */
  function samplePattern(pattern: Keyframe[], elapsed: number): number {
    if (elapsed <= pattern[0][0]) return pattern[0][1];
    if (elapsed >= pattern[pattern.length - 1][0]) return pattern[pattern.length - 1][1];

    let prev = pattern[0];
    for (let i = 1; i < pattern.length; i++) {
      const cur = pattern[i];
      if (elapsed < cur[0]) {
        const t = (elapsed - prev[0]) / (cur[0] - prev[0]);
        const s = t * t * (3 - 2 * t); // smooth-step
        return MathUtils.lerp(prev[1], cur[1], s);
      }
      prev = cur;
    }
    return prev[1];
  }

  useFrame(({ clock }) => {
    // Detect when progress crosses the flicker threshold → start ignition
    if (
      phaseRef.current === 'ramp' &&
      progress >= FLICKER_THRESHOLD &&
      prevProgressRef.current < FLICKER_THRESHOLD
    ) {
      phaseRef.current = 'flicker';
      flickerStartRef.current = clock.elapsedTime;
    }
    prevProgressRef.current = progress;

    let ambientBri: number;
    let spotBri: number;

    if (phaseRef.current === 'flicker') {
      const elapsed = clock.elapsedTime - flickerStartRef.current;
      if (elapsed >= FLICKER_DURATION) {
        phaseRef.current = 'on';
        ambientBri = 1;
        spotBri = 1;
      } else {
        // Blend: base ramp level + flicker on top
        const rampA = progress * 0.65; // ambient leads during ramp
        const rampS = Math.max(0, progress - 0.15) * 0.55; // spot trails
        const flickA = samplePattern(AMBIENT_FLICKER, elapsed);
        const flickS = samplePattern(SPOT_FLICKER, elapsed);
        ambientBri = Math.min(1, Math.max(rampA, flickA));
        spotBri = Math.min(1, Math.max(rampS, flickS));
      }
    } else if (phaseRef.current === 'on') {
      // Hold at full — smooth out any residual gap
      const curA = ambientRef.current ? ambientRef.current.intensity / AMBIENT_TARGET : 0;
      const curS = spotRef.current ? spotRef.current.intensity / SPOT_TARGET : 0;
      ambientBri = MathUtils.lerp(curA, 1, 0.06);
      spotBri = MathUtils.lerp(curS, 1, 0.06);
    } else {
      // Ramp phase — gradual brightening synced to boot progress.
      // Ambient leads, spot trails behind by ~0.15 progress units.
      const targetA = progress * 0.65; // ambient reaches ~65% by flicker threshold
      const targetS = Math.max(0, progress - 0.15) * 0.55; // spot delayed & dimmer

      // Smooth lerp so transitions feel organic, not steppy
      const curA = ambientRef.current ? ambientRef.current.intensity / AMBIENT_TARGET : 0;
      const curS = spotRef.current ? spotRef.current.intensity / SPOT_TARGET : 0;
      ambientBri = MathUtils.lerp(curA, targetA, 0.04);
      spotBri = MathUtils.lerp(curS, targetS, 0.04);
    }

    if (ambientRef.current) {
      ambientRef.current.intensity = ambientBri * AMBIENT_TARGET;
    }
    if (spotRef.current) {
      spotRef.current.intensity = spotBri * SPOT_TARGET;
    }
  });

  return (
    <>
      <ambientLight ref={ambientRef} intensity={0} />
      <spotLight
        ref={spotRef}
        castShadow
        intensity={0}
        decay={0}
        angle={0.2}
        penumbra={1}
        position={[-25, 20, -15]}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0001}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  3D Planet model                                                    */
/* ------------------------------------------------------------------ */

/** Resolve a public-dir asset path that works under both dev (http) and production (file://) */
const assetUrl = (name: string) => `${import.meta.env.BASE_URL}${name}`;

function Planet({ url }: { url: string }) {
  const { nodes } = useGLTF(url) as any;
  const groupRef = useRef<Group>(null);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.position.y = -7 + Math.sin(clock.elapsedTime * 0.4) * 0.35;
    }
  });

  return (
    <group ref={groupRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, -7, 0]} scale={7}>
      <group rotation={[Math.PI / 13.5, -Math.PI / 5.8, Math.PI / 5.6]}>
        <mesh receiveShadow castShadow geometry={nodes.planet002.geometry} material={nodes.planet002.material} />
        <mesh geometry={nodes.planet003.geometry} material={nodes.planet003.material} />
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/*  Splash Screen                                                      */
/* ------------------------------------------------------------------ */

/** Render a single text line with syntax highlighting. */
function renderTextLine(text: string): JSX.Element | string {
  if (text === '') return '\u00A0';
  if (text.includes('[  OK  ]')) {
    return (
      <>
        <span className="text-emerald-400/80">[  OK  ]</span>
        <span>{text.replace('[  OK  ]', '')}</span>
      </>
    );
  }
  if (text.startsWith('$') || text.startsWith('>')) {
    return <span className="text-fuchsia-400/80">{text}</span>;
  }
  if (text.startsWith('────')) {
    return <span className="text-white/30">{text}</span>;
  }
  return text;
}

interface SplashScreenProps {
  onEnter: () => void;
}

export function SplashScreen({ onEnter }: SplashScreenProps) {
  const [leaving, setLeaving] = useState(false);
  const hasClickedRef = useRef(false);

  // Boot sequence state
  const [termLines, setTermLines] = useState<string[]>([]);
  const [bootDone, setBootDone] = useState(false);       // boot animation finished
  const [dataReady, setDataReady] = useState(() => isPrefetchReady()); // data loaded
  const [bootProgress, setBootProgress] = useState(0);   // 0–1 drives scene lights
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Button is only shown when BOTH conditions are met:
  // the boot animation has completed AND the data is in memory.
  const showButton = bootDone && dataReady;

  // ---- Kick off data prefetch and track readiness ----
  useEffect(() => {
    let cancelled = false;

    // If data is already loaded (e.g. HMR re-mount), nothing to do.
    if (isPrefetchReady()) {
      setDataReady(true);
      return;
    }

    const markReady = () => { if (!cancelled) setDataReady(true); };

    getCachedBrowseData()
      .then(cached => {
        // getCachedBrowseData() already populates the in-memory prefetch
        // store when a cache hit occurs, so isPrefetchReady() is now true.
        if (cached) {
          console.log(`[Splash] Cache hit — ${cached.games.length} games (fresh=${cached.isFresh})`);
          markReady();
          // If the cache is stale, trigger a silent background refresh
          // (the dashboard will swap in the fresh data when it arrives).
          if (!cached.isFresh) {
            console.log('[Splash] Cache stale — starting background refresh...');
            prefetchBrowseData().then(games => {
              console.log(`[Splash] Background refresh done — ${games.length} games`);
            }).catch((err) => { console.warn('[Splash] Background refresh:', err); });
          }
        } else {
          // Cache miss (first launch) — do a full fetch.
          console.log('[Splash] Cache miss — starting background prefetch...');
          prefetchBrowseData().then(games => {
            console.log(`[Splash] Background prefetch done — ${games.length} games`);
            markReady();
          }).catch(err => {
            console.warn('[Splash] Background prefetch failed:', err);
            // Let the user in even if prefetch failed — the dashboard has
            // its own fallback fetch logic.
            markReady();
          });
        }
      })
      .catch((err) => {
        console.warn('[Splash] Cache load:', err);
        prefetchBrowseData()
          .then(() => markReady())
          .catch(() => markReady()); // fail-open: don't strand the user on splash
      });

    // News is non-critical — fire-and-forget.
    fetchAllNews().then(items => {
      console.log(`[Splash] News preloaded — ${items.length} articles cached`);
    }).catch((err) => { console.warn('[Splash] News fetch:', err); });

    // Safety timeout: don't strand the user on the splash screen forever.
    // If data still hasn't arrived after 30s, let them in anyway.
    const safetyTimer = setTimeout(() => {
      if (!cancelled && !isPrefetchReady()) {
        console.warn('[Splash] Safety timeout — allowing entry with partial data');
        markReady();
      }
    }, 30_000);

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
  }, []);

  // Auto-scroll terminal when content changes
  useEffect(() => {
    requestAnimationFrame(() => {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, [termLines]);

  // ---- Run boot terminal animation (fast line-by-line) ----
  useEffect(() => {
    let cancelled = false;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const addLine = (content: string) => {
      if (cancelled) return;
      setTermLines(prev => [...prev, content]);
    };

    const wait = (ms: number) => new Promise<void>(resolve => {
      if (cancelled) { resolve(); return; }
      pendingTimer = setTimeout(() => { pendingTimer = null; resolve(); }, ms);
    });

    const runBoot = async () => {
      await wait(1200); // let ARK title animate in first

      for (const line of BOOT_LINES) {
        if (cancelled) return;
        addLine(pick(line.variants));
        setBootProgress(line.light);
        await wait(line.delay);
      }

      if (cancelled) return;
      setBootDone(true);
    };

    runBoot();

    return () => {
      cancelled = true;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
    };
  }, []);

  const handleEnter = useCallback(() => {
    if (hasClickedRef.current) return;
    hasClickedRef.current = true;
    setLeaving(true);
    setTimeout(() => onEnter(), 800);
  }, [onEnter]);

  return (
    <AnimatePresence>
      {!leaving ? (
        <motion.div
          key="splash"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8 }}
          className="fixed inset-0 z-[10000] overflow-hidden"
          style={{ background: '#000000' }}
        >
          {/* Radial gradient background */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse at 50% 110%, rgba(168, 85, 247, 0.15) 0%, rgba(139, 92, 246, 0.08) 25%, rgba(15, 10, 25, 0.4) 50%, #000000 75%)',
            }}
          />

          {/* Three.js Canvas — wrapped in error boundary so a WebGL / GLB
              failure doesn't crash the entire application */}
          <div className="absolute inset-0">
            <CanvasErrorBoundary>
              <Canvas dpr={[1.5, 2]} linear shadows>
                <fog attach="fog" args={['#0a0010', 16, 30]} />
                <SceneLights progress={bootProgress} />
                <PerspectiveCamera makeDefault position={[0, 0, 16]} fov={75} />
                <Suspense fallback={null}>
                  <Planet url={assetUrl('scene.glb')} />
                </Suspense>
                <OrbitControls
                  autoRotate
                  autoRotateSpeed={0.5}
                  enablePan={false}
                  enableZoom={false}
                  maxPolarAngle={Math.PI / 2}
                  minPolarAngle={Math.PI / 2}
                />
                <Stars radius={500} depth={50} count={1000} factor={10} />
              </Canvas>
            </CanvasErrorBoundary>
          </div>

          {/* Overlay gradient */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'linear-gradient(0deg, rgba(139, 92, 246, 0.12) 0%, transparent 40%)',
            }}
          />

          {/* ---- Window controls (top-right) ---- */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="absolute top-0 left-0 right-0 z-20 flex items-center justify-end px-5 py-3 drag-region"
          >
            <div className="no-drag">
              <WindowControls />
            </div>
          </motion.div>

          {/* ---- Left-side black fade behind text area ---- */}
          <div
            className="absolute inset-y-0 left-0 z-[15] pointer-events-none"
            style={{
              width: '27.5%',
              background: 'linear-gradient(to right, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.85) 50%, rgba(0,0,0,0.5) 80%, transparent 100%)',
            }}
          />

          {/* ---- Left column: ARK title + version + boot terminal + button ---- */}
          <div className="absolute inset-0 z-20 flex flex-col pointer-events-none">
            {/* ARK title + version */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 1.0, delay: 0.5, ease: 'easeOut' }}
              className="select-none pl-10 pt-6 shrink-0"
            >
              <h1
                className="text-white leading-[0.82] tracking-[0.04em]"
                style={{
                  fontFamily: "'Sterion', sans-serif",
                  fontSize: '13rem',
                  textShadow: '0 0 80px rgba(255, 255, 255, 0.06)',
                }}
              >
                ARK
              </h1>
              <div className="flex items-center gap-3 -mt-4 ml-2">
                <span
                  className="text-white/35 tracking-[0.25em] uppercase"
                  style={{
                    fontFamily: "'Bebas Neue', sans-serif",
                    fontSize: '1.4rem',
                  }}
                >
                  v{APP_VERSION}
                </span>
                <span
                  className={`tracking-[0.18em] uppercase font-mono text-[0.7rem] font-bold transition-colors duration-700 ${
                    showButton
                      ? 'text-emerald-400'
                      : bootDone
                        ? 'text-cyan-400/80 animate-pulse'
                        : 'text-amber-400/70 animate-pulse'
                  }`}
                >
                  {showButton ? '● ONLINE' : bootDone ? '◌ SYNCING DATA...' : '◌ BOOTING...'}
                </span>
              </div>
            </motion.div>

            {/* Boot terminal — scrollable, fills remaining space */}
            <div className="flex-1 overflow-y-auto pl-10 pr-[50%] pb-8 pt-2 scrollbar-hide">
              <div className="font-mono text-[11px] leading-[1.6] text-white/70 whitespace-pre select-none">
                {termLines.map((line, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.05 }}
                  >
                    {renderTextLine(line)}
                  </motion.div>
                ))}

                {/* Blinking cursor while boot is running */}
                {!bootDone && termLines.length > 0 && (
                  <span className="inline-block w-[7px] h-[13px] bg-white/70 animate-pulse ml-0.5 align-middle" />
                )}

                {/* Waiting for data — boot finished but data still loading */}
                {bootDone && !dataReady && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3 }}
                    className="text-cyan-400/70 animate-pulse"
                  >
                    {'> Synchronising game vault — stand by...'}
                  </motion.div>
                )}

                <div ref={terminalEndRef} />
              </div>

              {/* Prominent CTA button — appears after boot completes */}
              {showButton && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                  className="mt-6 pointer-events-auto"
                >
                  <button
                    onClick={handleEnter}
                    className="group relative flex items-center gap-3 px-8 py-3.5 rounded-lg font-semibold text-white text-sm
                      cursor-pointer transition-all duration-300 ease-out
                      hover:scale-[1.03] hover:shadow-[0_0_50px_rgba(168,85,247,0.35)] active:scale-95
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/60"
                    style={{
                      background: 'linear-gradient(135deg, #a855f7 0%, #7c3aed 50%, #6d28d9 100%)',
                      boxShadow: '0 0 30px rgba(168, 85, 247, 0.3), inset 0 1px 0 rgba(255,255,255,0.15)',
                    }}
                  >
                    <span className="h-7 w-7 bg-white/15 rounded-md flex items-center justify-center">
                      <Gamepad2 className="h-4 w-4 text-white" />
                    </span>
                    Enter Ark
                    <svg
                      className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                  </button>
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>
      ) : (
        /* Fade-to-black transition before dashboard */
        <motion.div
          key="splash-exit"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
          className="fixed inset-0 z-[10000] bg-black"
        />
      )}
    </AnimatePresence>
  );
}

// Eagerly start fetching the GLB model as soon as this module is imported,
// so it's (likely) cached by the time the Canvas mounts the Planet component.
useGLTF.preload(assetUrl('scene.glb'));
