/**
 * Splash 3D Scene — lazy-loaded Three.js canvas for the splash screen.
 *
 * Separated from splash-screen.tsx so the splash shell (gradient, title,
 * terminal) can render instantly without waiting for three / fiber / drei
 * to parse and execute (~700KB).
 */

import { useRef, Suspense, memo } from 'react';
import type { MutableRefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, OrbitControls, PerspectiveCamera, Stars } from '@react-three/drei';
import { MathUtils } from 'three';
import type { Group, AmbientLight, SpotLight } from 'three';

const FLICKER_THRESHOLD = 0.72;

function SceneLights({ progressRef }: { progressRef: MutableRefObject<number> }) {
  const ambientRef = useRef<AmbientLight>(null);
  const spotRef = useRef<SpotLight>(null);

  const AMBIENT_TARGET = 0.75 * Math.PI;
  const SPOT_TARGET = 2.25 * Math.PI;

  const phaseRef = useRef<'ramp' | 'flicker' | 'on'>('ramp');
  const flickerStartRef = useRef(0);
  const prevProgressRef = useRef(0);

  type Keyframe = [time: number, brightness: number];

  const AMBIENT_FLICKER: Keyframe[] = [
    [0.00, 0.00], [0.05, 0.55], [0.12, 0.30], [0.22, 0.70],
    [0.30, 0.45], [0.40, 0.82], [0.48, 0.60], [0.58, 0.90],
    [0.70, 0.95], [0.82, 1.00],
  ];

  const SPOT_FLICKER: Keyframe[] = [
    [0.00, 0.00], [0.08, 0.00], [0.14, 0.25], [0.20, 0.05],
    [0.30, 0.45], [0.36, 0.12], [0.46, 0.60], [0.52, 0.30],
    [0.60, 0.75], [0.66, 0.50], [0.76, 0.88], [0.88, 1.00],
  ];

  const FLICKER_DURATION = Math.max(
    AMBIENT_FLICKER[AMBIENT_FLICKER.length - 1][0],
    SPOT_FLICKER[SPOT_FLICKER.length - 1][0],
  );

  function samplePattern(pattern: Keyframe[], elapsed: number): number {
    if (elapsed <= pattern[0][0]) return pattern[0][1];
    if (elapsed >= pattern[pattern.length - 1][0]) return pattern[pattern.length - 1][1];
    let prev = pattern[0];
    for (let i = 1; i < pattern.length; i++) {
      const cur = pattern[i];
      if (elapsed < cur[0]) {
        const t = (elapsed - prev[0]) / (cur[0] - prev[0]);
        const s = t * t * (3 - 2 * t);
        return MathUtils.lerp(prev[1], cur[1], s);
      }
      prev = cur;
    }
    return prev[1];
  }

  useFrame(({ clock }) => {
    const progress = progressRef.current;
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
        const rampA = progress * 0.65;
        const rampS = Math.max(0, progress - 0.15) * 0.55;
        const flickA = samplePattern(AMBIENT_FLICKER, elapsed);
        const flickS = samplePattern(SPOT_FLICKER, elapsed);
        ambientBri = Math.min(1, Math.max(rampA, flickA));
        spotBri = Math.min(1, Math.max(rampS, flickS));
      }
    } else if (phaseRef.current === 'on') {
      const curA = ambientRef.current ? ambientRef.current.intensity / AMBIENT_TARGET : 0;
      const curS = spotRef.current ? spotRef.current.intensity / SPOT_TARGET : 0;
      ambientBri = MathUtils.lerp(curA, 1, 0.06);
      spotBri = MathUtils.lerp(curS, 1, 0.06);
    } else {
      const targetA = progress * 0.65;
      const targetS = Math.max(0, progress - 0.15) * 0.55;
      const curA = ambientRef.current ? ambientRef.current.intensity / AMBIENT_TARGET : 0;
      const curS = spotRef.current ? spotRef.current.intensity / SPOT_TARGET : 0;
      ambientBri = MathUtils.lerp(curA, targetA, 0.04);
      spotBri = MathUtils.lerp(curS, targetS, 0.04);
    }

    if (ambientRef.current) ambientRef.current.intensity = ambientBri * AMBIENT_TARGET;
    if (spotRef.current) spotRef.current.intensity = spotBri * SPOT_TARGET;
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

export const Splash3DScene = memo(function Splash3DScene({
  progressRef,
}: {
  progressRef: MutableRefObject<number>;
}) {
  return (
    <Canvas dpr={[1.5, 2]} linear shadows>
      <fog attach="fog" args={['#0a0010', 16, 30]} />
      <SceneLights progressRef={progressRef} />
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
      <Stars radius={500} depth={50} count={500} factor={10} />
    </Canvas>
  );
});

try {
  useGLTF.preload(assetUrl('scene.glb'));
} catch {
  // CanvasErrorBoundary in splash-screen.tsx handles runtime failures
}
