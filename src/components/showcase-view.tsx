/**
 * Journey Ark — 3D Card Wheel Showcase
 *
 * A discrete card-selector carousel: one card is always "active".
 * Arrow keys / mouse-wheel step through cards; the wheel smoothly
 * spins to bring the active card to the front, where it faces the
 * camera and lights up. All other cards stay dimmed on the ring.
 *
 * Each card manages its own texture loading with a fallback URL chain —
 * no external probing, no Suspense boundaries for images.
 */
import { useMemo, useRef, useState, useCallback, useEffect, memo } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import { Stars, Html } from '@react-three/drei';
import { easing, geometry } from 'maath';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, Calendar, Star, Library } from 'lucide-react';
import type { JourneyEntry, GameStatus } from '@/types/game';
import { cn, buildGameImageChain, formatHours } from '@/lib/utils';
import { libraryStore } from '@/services/library-store';

extend(geometry);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShowcaseViewProps {
  entries: JourneyEntry[];
}

interface GenreGroup {
  genre: string;
  entries: JourneyEntry[];
  from: number;
  len: number;
}

interface FlatCard {
  entry: JourneyEntry;
  angle: number;
  genre: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_GENRES = 6;
const MAX_CARDS_PER_GENRE = 18;
const WHEEL_RADIUS = 5.25;
const CARD_W = 0.7;
const CARD_H = CARD_W * 1.5;
const CARD_DEPTH = 0.04;
const WHEEL_DAMP = 0.25;
const CARD_DAMP = 0.15;

// shared texture loader instance
const textureLoader = new THREE.TextureLoader();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build the full fallback chain of image URLs for a journey entry. */
function getImageChain(entry: JourneyEntry): string[] {
  const libEntry = libraryStore.getEntry(entry.gameId);
  const meta = libEntry?.cachedMeta;
  const coverUrl = entry.coverUrl || meta?.coverUrl;
  const headerImage = meta?.headerImage;
  return buildGameImageChain(entry.gameId, entry.title, coverUrl, headerImage);
}

function buildGenreGroups(entries: JourneyEntry[]): GenreGroup[] {
  const genreMap = new Map<string, JourneyEntry[]>();
  for (const e of entries) {
    const primary = e.genre?.[0] || 'Other';
    if (!genreMap.has(primary)) genreMap.set(primary, []);
    genreMap.get(primary)!.push(e);
  }

  const sorted = [...genreMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_GENRES);

  const totalEntries = sorted.reduce((sum, [, g]) => sum + Math.min(g.length, MAX_CARDS_PER_GENRE), 0);
  const TWO_PI = Math.PI * 2;
  const GAP = 0.08;

  let cursor = 0;
  return sorted.map(([genre, genreEntries]) => {
    const count = Math.min(genreEntries.length, MAX_CARDS_PER_GENRE);
    const arcLen = (count / totalEntries) * (TWO_PI - GAP * sorted.length);
    const group: GenreGroup = { genre, entries: genreEntries.slice(0, count), from: cursor, len: arcLen };
    cursor += arcLen + GAP;
    return group;
  });
}

function flattenCards(groups: GenreGroup[]): FlatCard[] {
  const result: FlatCard[] = [];
  for (const group of groups) {
    const count = group.entries.length;
    for (let i = 0; i < count; i++) {
      const chain = getImageChain(group.entries[i]);
      if (chain.length === 0) continue;
      result.push({
        entry: group.entries[i],
        angle: group.from + (i / count) * group.len,
        genre: group.genre,
      });
    }
  }
  return result;
}

/** Normalize an angle difference into [-PI, PI] for shortest-path rotation. */
function shortestAngleDelta(from: number, to: number): number {
  let d = to - from;
  d = ((d + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ─── Texture hook ─────────────────────────────────────────────────────────────

/**
 * Loads a texture using THREE.TextureLoader with an automatic fallback chain.
 * Tries each URL in order. Returns the loaded texture (or null while loading / if all fail).
 * Completely avoids Suspense & Error Boundaries — purely imperative.
 */
function useFallbackTexture(urls: string[]): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const attemptRef = useRef(0);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  useEffect(() => {
    let cancelled = false;
    attemptRef.current = 0;
    setTexture(null);

    function tryNext(idx: number) {
      if (cancelled) return;
      if (idx >= urlsRef.current.length) return; // all failed

      textureLoader.load(
        urlsRef.current[idx],
        (tex) => {
          if (cancelled) { tex.dispose(); return; }
          setTexture(tex);
        },
        undefined,
        () => {
          // error — try next URL in chain
          if (!cancelled) tryNext(idx + 1);
        },
      );
    }

    tryNext(0);

    return () => { cancelled = true; };
    // re-run only when the URL chain identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join('|')]);

  return texture;
}

// ─── Three.js Components ──────────────────────────────────────────────────────

function Scene({
  groups,
  flatCards,
  activeIndex,
  setActiveIndex,
}: {
  groups: GenreGroup[];
  flatCards: FlatCard[];
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}) {
  const wheelRef = useRef<THREE.Group>(null!);
  const total = flatCards.length;

  const activeEntry = flatCards[activeIndex]?.entry ?? null;

  // Initialize wheel rotation so the default active card starts at the front
  const initialAngle = total > 0 ? -flatCards[activeIndex].angle : 0;
  const targetRotation = useRef(initialAngle);
  const prevIndex = useRef(activeIndex);
  const initialized = useRef(false);

  useFrame((state, delta) => {
    if (!wheelRef.current || total === 0) return;

    // On the very first frame, snap the wheel to the correct rotation (no animation)
    if (!initialized.current) {
      targetRotation.current = -flatCards[activeIndex].angle;
      wheelRef.current.rotation.y = targetRotation.current;
      prevIndex.current = activeIndex;
      initialized.current = true;
    }

    if (activeIndex !== prevIndex.current) {
      const newAngle = -flatCards[activeIndex].angle;
      const diff = shortestAngleDelta(targetRotation.current, newAngle);
      targetRotation.current += diff;
      prevIndex.current = activeIndex;
    }

    easing.damp(wheelRef.current.rotation, 'y', targetRotation.current, WHEEL_DAMP, delta);

    state.events.update?.();
    easing.damp3(
      state.camera.position,
      [-state.pointer.x * 2, state.pointer.y * 2 + 4.5, 9] as unknown as THREE.Vector3,
      0.3,
      delta,
    );
    state.camera.lookAt(0, 0, 0);
  });

  const handleSelect = useCallback(
    (gameId: string) => {
      const idx = flatCards.findIndex((c) => c.entry.gameId === gameId);
      if (idx >= 0) setActiveIndex(idx);
    },
    [flatCards, setActiveIndex],
  );

  return (
    <>
      <ambientLight intensity={1.2} />
      <pointLight position={[0, 8, 0]} intensity={1} color="#d946ef" distance={30} decay={2} />
      <Stars radius={30} depth={60} count={1500} factor={3} saturation={0} fade speed={0.5} />
      <ActiveGlow activeEntry={activeEntry} wheelRef={wheelRef} />

      <group ref={wheelRef} position={[0, 1.5, 0]}>
        {groups.map((group) => (
          <GenreArc
            key={group.genre}
            group={group}
            radius={WHEEL_RADIUS}
            activeGameId={activeEntry?.gameId ?? ''}
            onSelect={handleSelect}
          />
        ))}
        <YearMarkers flatCards={flatCards} radius={WHEEL_RADIUS} />
      </group>

    </>
  );
}

/** Fuchsia point light that drifts toward the active card's world position. */
function ActiveGlow({
  activeEntry,
  wheelRef,
}: {
  activeEntry: JourneyEntry | null;
  wheelRef: React.RefObject<THREE.Group>;
}) {
  const lightRef = useRef<THREE.PointLight>(null!);
  const posRef = useRef(new THREE.Vector3(0, 3, WHEEL_RADIUS));

  useFrame((_state, delta) => {
    if (!lightRef.current) return;
    const target = activeEntry ? 1.5 : 0;
    lightRef.current.intensity += (target - lightRef.current.intensity) * Math.min(1, delta * 4);
    lightRef.current.position.lerp(posRef.current, Math.min(1, delta * 3));
  });

  useFrame(() => {
    if (!wheelRef.current || !activeEntry) return;
    const y = wheelRef.current.rotation.y;
    posRef.current.set(
      Math.sin(y) * WHEEL_RADIUS * -1,
      2,
      Math.cos(y) * WHEEL_RADIUS * -1,
    );
  });

  return <pointLight ref={lightRef} color="#d946ef" distance={5} decay={2} intensity={0} />;
}

/** One genre's arc — renders floor arc indicator and each card. */
function GenreArc({
  group,
  radius,
  activeGameId,
  onSelect,
}: {
  group: GenreGroup;
  radius: number;
  activeGameId: string;
  onSelect: (gameId: string) => void;
}) {
  const { entries: genreEntries, from, len } = group;
  const count = genreEntries.length;
  const yOffset = count % 2 === 0 ? 0.4 : -0.3;

  return (
    <group>
      <GenreFloorArc from={from} len={len} radius={radius} />

      <group position={[0, yOffset, 0]}>
      {genreEntries.map((entry, i) => {
        const angle = from + (i / count) * len;
        const urls = getImageChain(entry);
        if (urls.length === 0) return null;
        return (
          <Card
            key={entry.gameId}
            urls={urls}
            isActive={entry.gameId === activeGameId}
            hoursPlayed={entry.hoursPlayed}
            position={[Math.sin(angle) * radius, 0, Math.cos(angle) * radius]}
            rotation={[0, Math.PI / 2 + angle, 0]}
            onClick={(e: any) => {
              e.stopPropagation?.();
              onSelect(entry.gameId);
            }}
          />
        );
      })}
      </group>
    </group>
  );
}

/** Vertical tick markers with year labels on the floor ring. Uses Html to avoid font-loading issues. */
function YearMarkers({ flatCards, radius }: { flatCards: FlatCard[]; radius: number }) {
  const markers = useMemo(() => {
    const yearAngles = new Map<number, number[]>();
    for (const card of flatCards) {
      const year = new Date(card.entry.addedAt).getFullYear();
      if (!yearAngles.has(year)) yearAngles.set(year, []);
      yearAngles.get(year)!.push(card.angle);
    }

    const result: { year: number; angle: number }[] = [];
    for (const [year, angles] of yearAngles) {
      let sinSum = 0, cosSum = 0;
      for (const a of angles) { sinSum += Math.sin(a); cosSum += Math.cos(a); }
      const midAngle = Math.atan2(sinSum / angles.length, cosSum / angles.length);
      result.push({ year, angle: midAngle });
    }

    return result.sort((a, b) => a.year - b.year);
  }, [flatCards]);

  const r = radius * 0.95;
  const floorY = -0.65;

  const tickLine = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0.35, 0),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: '#d946ef', transparent: true, opacity: 0.5 });
    return { geo, mat };
  }, []);

  return (
    <group>
      {markers.map(({ year, angle }) => {
        const x = Math.sin(angle) * r;
        const z = Math.cos(angle) * r;

        return (
          <group key={year} position={[x, floorY, z]}>
            <primitive object={new THREE.Line(tickLine.geo.clone(), tickLine.mat)} />
            <Html
              position={[0, 0.45, 0]}
              center
              zIndexRange={[0, 0]}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
              distanceFactor={8}
            >
              <span style={{
                color: '#d946ef',
                fontSize: '11px',
                fontWeight: 600,
                opacity: 0.7,
                letterSpacing: '0.05em',
                whiteSpace: 'nowrap',
              }}>
                {year}
              </span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** Subtle fuchsia arc on the floor beneath a genre's card section. */
function GenreFloorArc({ from, len, radius }: { from: number; len: number; radius: number }) {
  const lineRef = useRef<THREE.Line>(null!);

  const lineGeometry = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const segments = 48;
    const r = radius * 0.95;
    for (let i = 0; i <= segments; i++) {
      const angle = from + (i / segments) * len;
      pts.push(new THREE.Vector3(Math.sin(angle) * r, -0.65, Math.cos(angle) * r));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [from, len, radius]);

  const lineMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ color: '#d946ef', transparent: true, opacity: 0.25 }),
    [],
  );

  return <primitive ref={lineRef} object={new THREE.Line(lineGeometry, lineMaterial)} />;
}

/** Typewriter text effect for the hours stamp on the active card. */
function TypedHoursStamp({ text }: { text: string }) {
  const fullText = `// Hours Logged : ${text}`;
  const [count, setCount] = useState(0);
  const done = count >= fullText.length;

  useEffect(() => {
    setCount(0);
    let i = 0;
    const timer = setInterval(() => {
      i++;
      setCount(i);
      if (i >= fullText.length) clearInterval(timer);
    }, 22);
    return () => clearInterval(timer);
  }, [fullText]);

  return (
    <span style={{
      color: 'rgba(255,255,255,0.85)',
      fontSize: '45px',
      fontWeight: 600,
      letterSpacing: '0.04em',
      fontFamily: 'monospace',
      lineHeight: 1,
    }}>
      {fullText.slice(0, count)}
      <span style={{
        opacity: done ? 0 : 1,
        transition: done ? 'opacity 0.4s' : 'none',
        animation: done ? 'none' : 'arkCursorBlink 0.6s step-end infinite',
      }}>▌</span>
    </span>
  );
}

/**
 * A single card on the wheel. Manages its own texture loading with automatic
 * fallback through the URL chain using THREE.TextureLoader.
 *
 * When active: flies to the center, faces the camera, brightens, scales up.
 * Otherwise: dimmed at its ring position.
 */
function Card({
  urls,
  isActive,
  hoursPlayed,
  position: cardPos,
  rotation: cardRot,
  onClick,
}: {
  urls: string[];
  isActive: boolean;
  hoursPlayed: number;
  position: [number, number, number];
  rotation: [number, number, number];
  onClick: (e: any) => void;
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const slabRef = useRef<THREE.Group>(null!);
  const frontMatRef = useRef<THREE.MeshStandardMaterial>(null!);
  const backMatRef = useRef<THREE.MeshStandardMaterial>(null!);
  const defaultY = cardRot[1];
  const faceForwardY = defaultY - Math.PI / 2;
  const mounted = useRef(false);

  const texture = useFallbackTexture(urls);

  // Track active state transitions for the floating label
  const [showLabel, setShowLabel] = useState(false);
  useEffect(() => {
    if (isActive) {
      // Delay label appearance so the card has time to arrive at center
      const timer = setTimeout(() => setShowLabel(true), 200);
      return () => clearTimeout(timer);
    }
    setShowLabel(false);
  }, [isActive]);

  useFrame((_state, delta) => {
    if (!slabRef.current || !groupRef.current) return;

    if (!mounted.current) {
      groupRef.current.position.set(cardPos[0], cardPos[1], cardPos[2]);
      groupRef.current.rotation.set(cardRot[0], cardRot[1], cardRot[2]);
      mounted.current = true;
    }

    easing.damp3(
      groupRef.current.position,
      (isActive ? [0, 0.5, 0] : cardPos) as unknown as THREE.Vector3,
      0.2,
      delta,
    );

    const f = isActive ? 2.6 : 1;
    easing.damp3(
      slabRef.current.scale,
      [f, f, f] as unknown as THREE.Vector3,
      CARD_DAMP,
      delta,
    );

    const colorTarget = isActive ? '#ffffff' : '#999999';
    const colorSpeed = isActive ? 0.3 : 0.1;
    if (frontMatRef.current) {
      easing.dampC(frontMatRef.current.color, colorTarget, colorSpeed, delta);
    }
    if (backMatRef.current) {
      easing.dampC(backMatRef.current.color, colorTarget, colorSpeed, delta);
    }

    const targetY = isActive ? faceForwardY : defaultY;
    easing.damp(groupRef.current.rotation, 'y', targetY, CARD_DAMP, delta);
  });

  const hoursText = hoursPlayed > 0 ? formatHours(hoursPlayed) : '0 Mins';

  return (
    <group ref={groupRef} onClick={onClick}>
      <group ref={slabRef}>
        {/* Dark slab — always visible */}
        <mesh>
          <boxGeometry args={[CARD_W, CARD_H, CARD_DEPTH]} />
          <meshStandardMaterial color="#111" roughness={0.8} metalness={0.2} />
        </mesh>

        {/* Front face */}
        {texture && (
          <mesh position={[0, 0, CARD_DEPTH / 2 + 0.002]}>
            <planeGeometry args={[CARD_W, CARD_H]} />
            <meshStandardMaterial
              ref={frontMatRef}
              map={texture}
              transparent
              roughness={0.6}
              metalness={0.1}
            />
          </mesh>
        )}

        {/* Back face */}
        {texture && (
          <mesh position={[0, 0, -(CARD_DEPTH / 2 + 0.002)]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[CARD_W, CARD_H]} />
            <meshStandardMaterial
              ref={backMatRef}
              map={texture}
              transparent
              roughness={0.6}
              metalness={0.1}
            />
          </mesh>
        )}

        {/* Floating hours label — appears above the card when active */}
        {showLabel && (
          <Html
            position={[0, CARD_H / 2 + 0.12, CARD_DEPTH / 2 + 0.01]}
            center
            zIndexRange={[10, 10]}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
            distanceFactor={4}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                whiteSpace: 'nowrap',
                background: 'none',
                padding: 0,
                border: 'none',
                animation: 'arkHoursIn 0.45s cubic-bezier(0.16,1,0.3,1) forwards',
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(217,70,239,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
              <TypedHoursStamp text={hoursText} />
            </div>
            <style>{`
              @keyframes arkHoursIn {
                0% { opacity: 0; transform: translateY(8px) scale(0.7); filter: blur(4px); }
                60% { opacity: 1; transform: translateY(-2px) scale(1.04); filter: blur(0px); }
                100% { opacity: 1; transform: translateY(0px) scale(1); filter: blur(0px); }
              }
              @keyframes arkCursorBlink {
                50% { opacity: 0; }
              }
            `}</style>
          </Html>
        )}
      </group>
    </group>
  );
}

// ─── Metadata helpers (matching Voyage Log mode) ─────────────────────────────

const statusColors: Record<GameStatus, string> = {
  'Completed': 'bg-green-500/20 text-green-400 border-green-500/30',
  'Playing': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'Playing Now': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  'On Hold': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'Want to Play': 'bg-white/10 text-white/60 border-white/20',
};

const STAR_INDICES = [0, 1, 2, 3, 4];

const ArkStarRating = memo(function ArkStarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {STAR_INDICES.map((i) => (
        <Star
          key={i}
          className={cn(
            'w-3 h-3',
            i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-white/20'
          )}
        />
      ))}
    </div>
  );
});

// ─── Frequency-wave metadata bar ─────────────────────────────────────────────
// Each label is a "bar" in the spectrum. On card swap they exit downward in a
// fast staggered wave, then the new set rises upward with a spring bounce —
// resembling an audio frequency visualizer reacting to a beat.

/** Spring config shared by all wave items — punchy with a short settle. */
const WAVE_SPRING = { type: 'spring' as const, stiffness: 600, damping: 28, mass: 0.7 };
const WAVE_STAGGER = 0.035; // seconds between each bar
const EXIT_DURATION = 0.12;

/** A single "frequency bar" — wraps one metadata chip / label. */
function WaveItem({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scaleY: 0.3, filter: 'blur(4px)' }}
      animate={{
        opacity: 1,
        y: 0,
        scaleY: 1,
        filter: 'blur(0px)',
        transition: {
          ...WAVE_SPRING,
          delay: index * WAVE_STAGGER,
          // Opacity and blur resolve slightly faster than the bounce
          opacity: { duration: 0.18, delay: index * WAVE_STAGGER },
          filter: { duration: 0.22, delay: index * WAVE_STAGGER },
        },
      }}
      exit={{
        opacity: 0,
        y: -10,
        scaleY: 0.4,
        filter: 'blur(3px)',
        transition: {
          duration: EXIT_DURATION,
          delay: index * (WAVE_STAGGER * 0.6),
          ease: 'easeIn',
        },
      }}
      style={{ originY: 0.5 }}
      className="inline-flex items-center"
    >
      {children}
    </motion.div>
  );
}

/** Thin separator bar that participates in the wave but is just a visual tick. */
function WaveSep({ index }: { index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{
        opacity: 1,
        scaleY: 1,
        transition: { ...WAVE_SPRING, delay: index * WAVE_STAGGER },
      }}
      exit={{
        opacity: 0,
        scaleY: 0,
        transition: { duration: EXIT_DURATION, delay: index * (WAVE_STAGGER * 0.6) },
      }}
      style={{ originY: 0.5 }}
      className="w-px h-3.5 bg-white/10 mx-0.5"
    />
  );
}

/** Horizontal glow line that sweeps during transitions. */
function SweepLine() {
  return (
    <motion.div
      initial={{ scaleX: 0, opacity: 0 }}
      animate={{
        scaleX: [0, 1, 1, 0],
        opacity: [0, 0.7, 0.7, 0],
        transition: { duration: 0.5, times: [0, 0.3, 0.7, 1], ease: 'easeInOut' },
      }}
      className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-fuchsia-500 to-transparent"
      style={{ originX: 0 }}
    />
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function ShowcaseView({ entries }: ShowcaseViewProps) {
  const groups = useMemo(() => buildGenreGroups(entries), [entries]);
  const flatCards = useMemo(() => flattenCards(groups), [groups]);
  const total = flatCards.length;

  const defaultIndex = useMemo(() => {
    if (total === 0) return 0;
    let latestIdx = 0;
    let latestTime = 0;
    for (let i = 0; i < flatCards.length; i++) {
      const t = new Date(flatCards[i].entry.addedAt).getTime();
      if (t > latestTime) { latestTime = t; latestIdx = i; }
    }
    return latestIdx;
  }, [flatCards, total]);

  const [activeIndex, setActiveIndex] = useState(defaultIndex);

  useEffect(() => {
    if (total === 0) return;
    setActiveIndex(defaultIndex);
  }, [defaultIndex, total]);

  const activeCard = flatCards[activeIndex] ?? null;
  const wheelCooldown = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (total === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        setActiveIndex((p) => (p + 1) % total);
        e.preventDefault();
      }
      if (e.key === 'ArrowLeft') {
        setActiveIndex((p) => (p - 1 + total) % total);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || total === 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - wheelCooldown.current < 180) return;
      wheelCooldown.current = now;
      const dir = e.deltaY > 0 ? 1 : -1;
      setActiveIndex((p) => (p + dir + total) % total);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [total]);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-8rem)] text-white/40 text-sm">
        No games in your voyage yet. Add some games to your library first!
      </div>
    );
  }

  const entry = activeCard?.entry ?? null;
  const inLibrary = entry ? libraryStore.isInLibrary(entry.gameId) : false;
  const isRemoved = !!entry?.removedAt;
  const addedDate = entry?.addedAt
    ? new Date(entry.addedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : '';

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-black rounded-lg overflow-hidden">
      {/* Active card metadata — frequency-wave animated bar */}
      <div className="flex-shrink-0 border-b border-white/10 bg-black/90 backdrop-blur-sm px-6 py-2.5 relative overflow-hidden min-h-[40px]">
        <AnimatePresence mode="wait">
          {entry && (
            <motion.div
              key={entry.gameId}
              className="flex items-center justify-center gap-3 flex-wrap"
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <SweepLine />
              {(() => {
                // Build ordered list of metadata elements so each gets a wave index
                let idx = 0;
                const els: React.ReactNode[] = [];

                // Title
                els.push(
                  <WaveItem key="title" index={idx++}>
                    <span className="text-white text-sm font-semibold tracking-wide">
                      {entry.title}
                    </span>
                  </WaveItem>
                );

                // Sep + Genre
                els.push(<WaveSep key="sep1" index={idx++} />);
                els.push(
                  <WaveItem key="genre" index={idx++}>
                    <span className="text-fuchsia-400 text-[11px] font-medium uppercase tracking-widest">
                      {activeCard!.genre}
                    </span>
                  </WaveItem>
                );

                // Status badge
                if (entry.status) {
                  els.push(
                    <WaveItem key="status" index={idx++}>
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full border font-medium',
                        statusColors[entry.status]
                      )}>
                        {entry.status}
                      </span>
                    </WaveItem>
                  );
                }

                // In Library / Removed
                if (inLibrary && !isRemoved) {
                  els.push(
                    <WaveItem key="lib" index={idx++}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30 font-medium inline-flex items-center gap-0.5">
                        <Library className="w-2.5 h-2.5" />
                        In Library
                      </span>
                    </WaveItem>
                  );
                }
                if (isRemoved) {
                  els.push(
                    <WaveItem key="removed" index={idx++}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-red-500/10 text-red-400/70 border-red-500/20 font-medium">
                        Removed
                      </span>
                    </WaveItem>
                  );
                }

                // Sep + Hours
                els.push(<WaveSep key="sep2" index={idx++} />);
                els.push(
                  <WaveItem key="hours" index={idx++}>
                    <div className="flex items-center gap-1 text-xs text-white/50">
                      <Clock className="w-3 h-3" />
                      <span>{entry.hoursPlayed > 0 ? formatHours(entry.hoursPlayed) : '0 Mins'}</span>
                    </div>
                  </WaveItem>
                );

                // Rating
                if (entry.rating > 0) {
                  els.push(
                    <WaveItem key="rating" index={idx++}>
                      <ArkStarRating rating={entry.rating} />
                    </WaveItem>
                  );
                }

                // Added date
                if (addedDate) {
                  els.push(
                    <WaveItem key="date" index={idx++}>
                      <div className="flex items-center gap-1 text-xs text-white/40">
                        <Calendar className="w-3 h-3" />
                        <span>{addedDate}</span>
                      </div>
                    </WaveItem>
                  );
                }

                // Platform
                if (entry.platform?.length > 0) {
                  els.push(<WaveSep key="sep3" index={idx++} />);
                  els.push(
                    <WaveItem key="platform" index={idx++}>
                      <span className="text-white/30 text-[10px] uppercase tracking-wider">
                        {entry.platform.join(' · ')}
                      </span>
                    </WaveItem>
                  );
                }

                // Nav hint
                els.push(<WaveSep key="sep4" index={idx++} />);
                els.push(
                  <WaveItem key="nav" index={idx++}>
                    <span className="text-white/20 text-[10px] uppercase tracking-wider">
                      ← → browse
                    </span>
                  </WaveItem>
                );

                return els;
              })()}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 3D Canvas — fills remaining space */}
      <div ref={containerRef} className="flex-1 min-h-0 relative">
        <Canvas
          dpr={[1, 1.5]}
          style={{ background: '#000000' }}
          gl={{ antialias: true, alpha: false }}
          camera={{ fov: 50, near: 0.1, far: 100 }}
          className="animate-in fade-in duration-[2000ms]"
        >
        <Scene
          groups={groups}
          flatCards={flatCards}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
        />
        </Canvas>
      </div>

    </div>
  );
}
