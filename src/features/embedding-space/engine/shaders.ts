/**
 * Embedding Space v2 — GLSL sources.
 *
 * Ported verbatim from the Claude Design handoff (`galaxy-engine-v2.js`).
 * Colours, falloffs and constants are final design values; change them only
 * with design sign-off. (Fault-line fissure shaders were dropped: the handoff
 * disables that layer because it read as stray glowing lines.)
 */

// Cinema grade: filmic split-tone, soft shoulder, lifted-but-cool blacks, edge
// fringing, vignette, and a fine anamorphic streak only on the focused star.
export const CINEMA_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';

export const CINEMA_FS = `
uniform sampler2D tDiffuse; uniform vec2 uRes; uniform vec2 uFocus; uniform float uFocusOn; uniform float uTime; uniform float uBlur; uniform float uMotion; uniform float uMBlur; uniform float uFlash;
varying vec2 vUv;
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main(){
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 cd = vUv - 0.5; float ca = (0.0042 + uMotion * 0.006) * dot(cd, cd) * 4.0;
  vec3 col;
  col.r = (texture2D(tDiffuse, vUv + cd * ca).r + texture2D(tDiffuse, vUv + cd * ca * 0.5).r) * 0.5;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = (texture2D(tDiffuse, vUv - cd * ca).b + texture2D(tDiffuse, vUv - cd * ca * 0.5).b) * 0.5;
  if (uMBlur > 0.01) {
    // Zoom blur toward the flight's destination: stars streak along the direction of travel
    vec2 dir = (vUv - uFocus);
    vec3 acc = col; float wsum = 1.0;
    for (int k = 1; k <= 6; k++) {
      float t = float(k) / 6.0;
      float wk = 1.0 - t * 0.6;
      acc += texture2D(tDiffuse, vUv - dir * t * uMBlur * 0.022).rgb * wk; wsum += wk;
    }
    col = acc / wsum;
  }
  if (uBlur > 0.002) {
    float fd = length((vUv - uFocus) * asp);
    float amt = uBlur * smoothstep(0.1, 0.55, fd);
    if (amt > 0.002) {
      vec2 px = 1.0 / uRes; float rad = amt * 5.0;
      vec3 acc = col;
      acc += texture2D(tDiffuse, vUv + vec2( 1.0,  0.0) * px * rad).rgb;
      acc += texture2D(tDiffuse, vUv + vec2(-1.0,  0.0) * px * rad).rgb;
      acc += texture2D(tDiffuse, vUv + vec2( 0.0,  1.0) * px * rad).rgb;
      acc += texture2D(tDiffuse, vUv + vec2( 0.0, -1.0) * px * rad).rgb;
      acc += texture2D(tDiffuse, vUv + vec2( 0.7,  0.7) * px * rad * 1.6).rgb;
      acc += texture2D(tDiffuse, vUv + vec2(-0.7,  0.7) * px * rad * 1.6).rgb;
      acc += texture2D(tDiffuse, vUv + vec2( 0.7, -0.7) * px * rad * 1.6).rgb;
      acc += texture2D(tDiffuse, vUv + vec2(-0.7, -0.7) * px * rad * 1.6).rgb;
      col = mix(col, acc / 9.0, clamp(amt * 1.4, 0.0, 1.0));
    }
  }
  if (uFocusOn > 0.001) {
    vec3 st = vec3(0.0);
    float dy = abs(vUv.y - uFocus.y) * uRes.y;
    float band = exp(-dy * dy * 0.08);
    if (band > 0.002) {
      for (int i = -24; i <= 24; i++) {
        float fi = float(i);
        vec3 sm = texture2D(tDiffuse, vec2(vUv.x + fi * 0.0032, uFocus.y)).rgb;
        st += sm * max(lum(sm) - 0.95, 0.0) * exp(-abs(fi) * 0.16);
      }
      col += st * band * uFocusOn * 0.018 * vec3(0.62, 0.8, 1.0);
    }
  }
  if (uFocusOn > 0.001) {
    // Analytic lens flare: halo ring around the focus + hexagonal ghosts mirrored through centre
    vec2 fp = uFocus; vec2 axis = vec2(0.5) - fp;
    float fr = length((vUv - fp) * asp);
    col += vec3(0.55, 0.6, 0.75) * smoothstep(0.012, 0.0, abs(fr - 0.085)) * 0.05 * uFocusOn;
    for (int k = 0; k < 4; k++) {
      float fk = float(k);
      float t = 0.55 + fk * 0.42;
      vec2 gp = fp + axis * t * 2.0;
      vec2 dv = (vUv - gp) * asp;
      float rad = 0.018 + fk * 0.012;
      float ang = atan(dv.y, dv.x);
      float hexr = rad * (0.92 + 0.08 * cos(6.0 * ang));
      float ghost = smoothstep(hexr, hexr * 0.6, length(dv));
      vec3 tint = mix(vec3(0.45, 0.6, 1.0), vec3(1.0, 0.55, 0.85), fk / 3.0);
      col += tint * ghost * 0.028 * uFocusOn;
    }
  }
  if (uFlash > 0.001) {
    // Arrival: brief exposure bloom and a warm-white lift centred on the destination
    float fr2 = length((vUv - uFocus) * asp);
    col += col * uFlash * 0.18 + vec3(1.0, 0.94, 0.88) * exp(-fr2 * fr2 * 30.0) * uFlash * 0.05;
  }
  float l = lum(col);
  vec3 g = col * mix(vec3(0.92, 0.97, 1.07), vec3(1.05, 1.0, 0.94), smoothstep(0.03, 0.6, l));
  g = g / (1.0 + g * 0.22);
  g = max(g, vec3(0.006, 0.008, 0.014));
  float v = smoothstep(1.3, 0.3, length(cd * asp) * 0.95);
  g *= mix(0.42, 1.0, v);
  gl_FragColor = vec4(g, 1.0);
}`;

export const NODE_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aBrightness;
  attribute vec3 aCommunityColor;
  attribute float aPRBoost;
  attribute float aTwinklePhase;
  attribute float aPRDelta;
  uniform float u_time;
  uniform float u_communityMix;
  uniform float u_prAuroraMix;
  uniform float u_galacticTimeOfDay;
  attribute float aKeep;
  attribute float aDelay;
  uniform float u_igniteAge;
  varying vec3 vColor;
  varying float vBrightness;
  varying float vKeep;
  void main() {
    vKeep = aKeep;
    vec3 baseColor = mix(aColor, aCommunityColor, u_communityMix);
    vec3 warm = mix(vec3(0.98, 0.85, 0.40), vec3(1.00, 0.45, 0.30), clamp(aPRDelta, 0.0, 1.0));
    vec3 cold = mix(vec3(0.55, 0.30, 0.85), vec3(0.90, 0.30, 0.80), clamp(-aPRDelta, 0.0, 1.0));
    vec3 auroraTint = aPRDelta >= 0.0 ? warm : cold;
    float auroraStrength = abs(aPRDelta) * u_prAuroraMix;
    baseColor = mix(baseColor, auroraTint, auroraStrength);
    float dayPhase = 0.15 * sin(u_galacticTimeOfDay * 6.2831853);
    baseColor = mix(baseColor, baseColor * vec3(0.92, 0.88, 1.05), abs(dayPhase));
    // Stellar temperature: each star leans slightly blue-white or amber so a cluster isn't flat
    float temp = fract(aTwinklePhase * 7.31);
    vec3 tint = temp < 0.5 ? mix(vec3(0.75, 0.85, 1.15), vec3(1.0), temp * 2.0) : mix(vec3(1.0), vec3(1.15, 0.88, 0.7), (temp - 0.5) * 2.0);
    baseColor *= tint;
    float l = dot(baseColor, vec3(0.299, 0.587, 0.114));
    vColor = mix(vec3(l), baseColor, 1.25);
    float twinkle = 0.85 + 0.15 * sin(u_time * 1.4 + aTwinklePhase * 6.2831853);
    float prBoostMul = 1.0 + aPRBoost * 0.6;
    vBrightness = aBrightness * twinkle * prBoostMul;
    if (aDelay > 0.0) {
      float ign = smoothstep(aDelay, aDelay + 0.35, u_igniteAge);
      float flash = exp(-pow((u_igniteAge - aDelay - 0.3) * 5.0, 2.0)) * 0.7;
      vBrightness *= mix(0.12, 1.0, ign) + flash;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float prSizeMul = 1.0 + aPRBoost * 0.35;
    gl_PointSize = aSize * prSizeMul * (400.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

export const NODE_FRAGMENT = /* glsl */ `
  uniform float u_fade;
  uniform float u_keepFade;
  varying vec3 vColor;
  varying float vBrightness;
  varying float vKeep;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float core = exp(-34.0 * d * d);
    float halo = exp(-8.0 * d * d) * 0.14;
    float alpha = (core + halo) * vBrightness * mix(u_fade, 1.0, vKeep * u_keepFade);
    vec3 color = mix(vColor, vec3(1.0), core * 0.22);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export const NAMED_STAR_VERTEX = /* glsl */ `
  attribute vec3 aInstColor;
  attribute float aInstPhase;
  uniform float u_time;
  uniform float u_globalIntensity;
  varying vec3 vColor;
  varying float vRim;
  varying float vPulse;
  void main() {
    vColor = aInstColor;
    vPulse = 0.85 + 0.15 * sin(u_time * 0.7 + aInstPhase * 6.2831853);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 vn = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vRim = 1.0 - abs(normalize(-mv.xyz).z * vn.z + normalize(-mv.xyz).x * vn.x + normalize(-mv.xyz).y * vn.y);
    gl_Position = projectionMatrix * mv;
  }
`;

export const NAMED_STAR_FRAGMENT = /* glsl */ `
  uniform float u_globalIntensity;
  varying vec3 vColor;
  varying float vRim;
  varying float vPulse;
  void main() {
    float rimGlow = pow(clamp(vRim, 0.0, 1.0), 1.6);
    vec3 col = mix(vColor * 1.8, vColor + vec3(0.25), rimGlow);
    float a = clamp(0.65 + rimGlow * 0.4, 0.0, 1.0) * vPulse * u_globalIntensity;
    gl_FragColor = vec4(col * a, a);
  }
`;

export const FRONTIER_VERTEX = /* glsl */ `
  attribute float aIntensity;
  attribute float aPhase;
  uniform float u_time;
  uniform float u_globalIntensity;
  varying float vIntensity;
  varying float vHue;
  void main() {
    float breath = 0.82 + 0.18 * sin(u_time * 0.35 + aPhase * 6.2831853);
    vIntensity = aIntensity * u_globalIntensity * breath;
    vHue = clamp(aIntensity + 0.08 * sin(aPhase * 19.0 + u_time * 0.2), 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float size = 70.0 + aIntensity * 180.0;
    // Pixel cap: up close / dense regions must stay a soft haze, never a solid blob
    gl_PointSize = min(size * (400.0 / -mv.z), 42.0);
    gl_Position = projectionMatrix * mv;
  }
`;

export const FRONTIER_FRAGMENT = /* glsl */ `
  varying float vIntensity;
  varying float vHue;
  void main() {
    if (vIntensity < 0.02) discard;
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float falloff = exp(-9.0 * d * d);
    vec3 cyan    = vec3(0.18, 0.55, 0.92);
    vec3 violet  = vec3(0.45, 0.30, 0.90);
    vec3 magenta = vec3(0.90, 0.30, 0.75);
    vec3 col = mix(cyan, violet, smoothstep(0.0, 0.55, vHue));
    col = mix(col, magenta, smoothstep(0.55, 1.0, vHue));
    float a = falloff * vIntensity * 0.22;
    gl_FragColor = vec4(col * a, a);
  }
`;

export const SUN_VERTEX = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vViewDir;
  varying vec3 vViewNorm;
  void main() {
    vPos = position;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = -normalize(mvPos.xyz);
    vViewNorm = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const SUN_FRAGMENT = /* glsl */ `
  uniform float u_time;
  uniform vec3 u_color;
  uniform vec3 u_colorBright;
  varying vec3 vPos;
  varying vec3 vViewDir;
  varying vec3 vViewNorm;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 23.112))) * 43758.5453); }
  float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), u.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y),
      u.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    float t = u_time * 0.12;
    for (int i = 0; i < 5; i++) {
      v += a * noise3D(p + t);
      p = p * 2.1 + vec3(t * 0.3);
      a *= 0.5;
    }
    return v;
  }
  void main() {
    vec3 p = vPos * 3.5;
    vec3 q = vec3(fbm(p), fbm(p + vec3(5.2, 1.3, 2.8)), fbm(p + vec3(2.1, 3.7, 1.4)));
    float n = fbm(p + q * 2.0);
    vec3 col = mix(u_color, u_colorBright, clamp(n * n * 1.5, 0.0, 1.0));
    col = mix(col, u_color * 0.7, clamp(length(q) * 0.5, 0.0, 1.0));
    float rim = 1.0 - max(dot(vViewDir, vViewNorm), 0.0);
    col += u_colorBright * pow(rim, 2.0) * 0.45;
    gl_FragColor = vec4(col * 1.35, 1.0);
  }
`;

// Neighbour halos: hairline base ring + three slow arcs riding just outside it.
export const HALO_VERTEX = `attribute float aDelay; attribute float aDir; uniform float uAge; uniform float uPx;
  varying float vIn; varying float vDir;
  void main(){
    vIn = smoothstep(aDelay, aDelay + 0.45, uAge); vDir = aDir;
    gl_PointSize = (24.0 + 6.0 * (1.0 - vIn)) * uPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

export const HALO_FRAGMENT = `uniform float uTime; uniform float uOpacity; varying float vIn; varying float vDir;
  void main(){
    vec2 p = (gl_PointCoord - 0.5) * 2.0;
    float r = length(p);
    // hairline base ring + three slow arcs riding just outside it
    float px = 0.045;
    float base = 1.0 - smoothstep(0.0, px, abs(r - 0.7));
    float arcBand = 1.0 - smoothstep(0.0, px * 1.2, abs(r - 0.82));
    float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
    float f = fract(ang * 3.0 + uTime * 0.035 * vDir);
    float arc = smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(0.18, 0.24, f));
    float a = (base * 0.22 + arcBand * arc * 0.55) * vIn * uOpacity;
    if (a < 0.005) discard;
    gl_FragColor = vec4(vec3(1.0) * a, a);
  }`;

// Connection lines with a growing tip and a travelling flow pulse.
export const FLOW_LINE_VERTEX = `attribute float aT; attribute float aD; attribute float aI;
  varying float vT; varying float vD; varying float vI;
  void main(){ vT = aT; vD = aD; vI = aI; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const FLOW_LINE_FRAGMENT = `uniform float uAge; uniform float uTime; uniform float uOpacity; uniform vec3 uColor;
  varying float vT; varying float vD; varying float vI;
  void main(){
    float grow = clamp((uAge - vD) / 0.55, 0.0, 1.0);
    grow = 1.0 - pow(1.0 - grow, 3.0);
    if (vT > grow) discard;
    float tip = exp(-pow((vT - grow) * 14.0, 2.0)) * (1.0 - smoothstep(0.9, 1.0, grow));
    float p = fract(uTime * 0.08 + vD * 3.0);
    float pulse = exp(-pow((vT - p) * 9.0, 2.0)) * 0.28;
    float body = mix(0.34, 0.1, vT);
    float a = (body + pulse * vI + tip * 0.7) * vI * uOpacity;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), tip * 0.6) * a, a);
  }`;

// The Path ribbon. NOTE: the travel-head variable is `thead` — `head` collides
// with a three.js built-in and breaks compilation.
export const PATH_RIBBON_VERTEX = `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export const PATH_RIBBON_FRAGMENT = `
  uniform float uTime; uniform float uReveal; uniform float uHiT; uniform float uDim; varying float vT;
  uniform float uTravA; uniform float uTravB; uniform float uTravP; uniform float uTravOn;
  void main(){
    if (vT > uReveal) discard;
    vec3 past = vec3(0.30, 0.52, 0.95); vec3 now = vec3(0.93, 0.50, 0.98);
    vec3 col = mix(past, now, smoothstep(0.0, 1.0, vT));
    float base = mix(0.16, 0.42, vT);
    float head = fract(uTime * 0.05);
    float dt = vT - head; float comet = exp(-dt * dt * 2600.0) + (dt < 0.0 ? exp(dt * 34.0) * 0.25 : 0.0);
    float edge = exp(-(vT - uReveal) * (vT - uReveal) * 9000.0);
    float hi = uHiT >= 0.0 ? exp(-(vT - uHiT) * (vT - uHiT) * 900.0) * 0.6 : 0.0;
    float a = (base + comet * 0.8 + edge * 0.9 + hi) * uDim;
    float thead = mix(uTravA, uTravB, uTravP);
    float lo = min(uTravA, thead), hiT = max(uTravA, thead);
    float trail = step(lo, vT) * step(vT, hiT) * 0.6;
    float hg = exp(-pow((vT - thead) * 160.0, 2.0)) * 1.8;
    float tr = (trail + hg) * uTravOn;
    a += tr;
    gl_FragColor = vec4(mix(col, vec3(1.0), clamp(comet * 0.5 + edge * 0.6 + hg * uTravOn * 0.6, 0.0, 1.0)) * a, a);
  }`;

// Path waypoints: thin rings, radius ∝ sqrt(hours), filled as the ribbon reaches them.
export const PATH_WAYPOINT_VERTEX = `
  attribute float aSize; attribute float aT; attribute float aIdx;
  uniform float uReveal; uniform float uHi; uniform float uActive; uniform float uPx;
  varying float vT; varying float vOn; varying float vHi;
  void main(){
    vT = aT; vOn = smoothstep(aT - 0.02, aT + 0.01, uReveal);
    vHi = (abs(aIdx - uHi) < 0.5 ? 1.0 : 0.0) + (abs(aIdx - uActive) < 0.5 ? 0.6 : 0.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (1.0 + vHi * 0.45) * uPx * (260.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

export const PATH_WAYPOINT_FRAGMENT = `
  uniform float uDim; varying float vT; varying float vOn; varying float vHi;
  void main(){
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float ring = smoothstep(0.06, 0.0, abs(d - 0.42)) * 0.8;
    float dot = exp(-d * d * 140.0);
    vec3 col = mix(vec3(0.42, 0.6, 1.0), vec3(0.95, 0.6, 1.0), vT);
    float a = (ring * (0.35 + vHi * 0.65) + dot * 0.9) * vOn * uDim;
    gl_FragColor = vec4(mix(col, vec3(1.0), dot * 0.4 + vHi * 0.2) * a, a);
  }`;

// Nebulae: camera-facing volumes shaded procedurally — domain-warped emission gas,
// bright ionised filaments, dark dust lanes and an embedded star core.
export const NEB_FS = `uniform float uOpacity; uniform float uSeed; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uTime;
  varying vec2 vUv; varying float vNear;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
  float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++){ v += a * n(p); p = m * p; a *= 0.5; } return v; }
  void main(){
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    vec2 q = p * 1.7 + uSeed;
    vec2 w = vec2(fbm(q + vec2(0.0, uTime * 0.004)), fbm(q + vec2(5.2, 1.3)));
    float gas = fbm(q + 2.2 * w);
    float edge = 1.0 - smoothstep(0.35, 1.0, r + (fbm(q * 0.8 + 3.1) - 0.5) * 0.55);
    float density = smoothstep(0.32, 0.85, gas) * edge;
    float fil = pow(1.0 - abs(fbm(q * 2.3 + w * 1.5) * 2.0 - 1.0), 6.0) * edge;
    float dust = smoothstep(0.5, 0.72, fbm(q * 1.3 + 7.7 - w));
    vec3 col = mix(uA, uB, smoothstep(0.3, 0.8, gas));
    col = mix(col, uC, fil * 0.6);
    float core = exp(-r * r * 9.0) * 0.5;
    vec3 c = col * density * (1.0 - dust * 0.85) + uC * fil * 0.55 + vec3(1.0, 0.92, 0.85) * core * edge;
    float a = (density * 0.65 + fil * 0.35 + core * 0.4) * (1.0 - dust * 0.6) * uOpacity * vNear;
    gl_FragColor = vec4(c * a, a);
  }`;

export const NEB_BAKE_VS = 'varying vec2 vUv; varying float vNear; void main(){ vUv = uv; vNear = 1.0; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }';

export const NEB_SHOW_VS = 'varying vec2 vUv; varying float vNear; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vNear = smoothstep(140.0, 420.0, -mv.z); gl_Position = projectionMatrix * mv; }';

export const NEB_SHOW_FS = 'uniform sampler2D uTex; uniform float uOpacity; varying vec2 vUv; varying float vNear; void main(){ gl_FragColor = texture2D(uTex, vUv) * uOpacity * vNear; }';
