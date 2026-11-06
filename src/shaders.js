// Raymarched lava globe: outer glass refraction -> glass wall -> inner wall refraction ->
// volumetric liquid (bulb light scattering, wax light-shadows) -> wax iso-surface
// with subsurface-style shading, bottom coil, far-wall exit refraction into the room.

export const globeVert = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const globeFrag = /* glsl */`
precision highp float;
precision highp sampler3D;

uniform sampler3D uField;
uniform vec3 uFieldMin;
uniform vec3 uFieldSize;
uniform float uVoxel;
uniform float uIso;
uniform sampler2D uBg;
uniform samplerCube uEnv;
uniform float uEnvIntensity;
uniform mat4 uViewProj;
uniform vec3 uGlobeOrigin;
uniform vec3 uWax;
uniform vec3 uLiquid;
uniform vec3 uBulbColor;
uniform float uBulb;
uniform float uLiquidDensity;
uniform float uScatter;
uniform float uAmbient;
uniform float uThermal;
uniform float uTime;
uniform float uSteps;
uniform float uCloud;
uniform float uWaxGain;
uniform vec4 uProf;   // H, Rb, Rt, r0
uniform vec4 uProf2;  // yb, glass, waxTop, liquidTop

varying vec3 vWorld;
varying vec3 vNormalW;

const vec3 BULB = vec3(0.0, -0.05, 0.0);

float rIn(float y) {
  float H = uProf.x, Rb = uProf.y, Rt = uProf.z, r0 = uProf.w, yb = uProf2.x;
  if (y <= yb) { float s = 1.0 - max(y, 0.0) / yb; return Rb - (Rb - r0) * s * s; }
  float t = min(1.0, (y - yb) / (H - yb));
  const float e = 0.12;
  float s = (sqrt(t * t + e * e) - e) / (sqrt(1.0 + e * e) - e);
  return Rb + (Rt - Rb) * s;
}
float sdIn(vec3 p) { return length(p.xz) - rIn(p.y); }
vec3 nIn(vec3 p) {
  float e = 0.0006;
  float dr = (rIn(p.y + e) - rIn(p.y - e)) / (2.0 * e);
  vec2 d = normalize(p.xz + vec2(1e-7));
  return normalize(vec3(d.x, -dr, d.y));
}

vec4 field(vec3 p) { vec4 f = texture(uField, (p - uFieldMin) / uFieldSize); f.g *= f.g; return f; }
float dens(vec3 p) { return texture(uField, (p - uFieldMin) / uFieldSize).r; }

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// Light from the bulb hidden in the base, entering through the globe's bottom.
float bulbAt(vec3 p) {
  vec3 d = p - BULB;
  float r2 = dot(d, d);
  float cosT = d.y * inversesqrt(r2);
  float cone = mix(0.2, 1.0, smoothstep(0.35, 0.97, cosT));
  return uBulb * cone * 0.0042 / (r2 + 0.0008);
}

// Wire coil lying on the bottom of the globe (helps the wax melt in real lamps).
float sdCoil(vec3 p) {
  vec2 q = vec2(length(p.xz) - 0.025, p.y - 0.0042);
  float ph = atan(p.z, p.x) * 44.0;
  vec2 w = 0.0029 * vec2(cos(ph), sin(ph));
  return (length(q - w) - 0.00065) * 0.6;
}

vec3 envLod(vec3 d, float lod) { return textureLod(uEnv, d, lod).rgb * uEnvIntensity; }

vec3 bgAt(vec3 pLocal, vec3 dir) {
  vec3 w = pLocal + uGlobeOrigin + dir * 0.12;
  vec4 clip = uViewProj * vec4(w, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  return texture2D(uBg, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
}

vec3 thermal(float t) {
  // ironbow palette over the narrow operating band (a few degrees drive the whole lamp)
  t = clamp((t - 0.47) / 0.06, 0.0, 1.0);
  vec3 c = mix(vec3(0.02, 0.0, 0.12), vec3(0.45, 0.0, 0.6), smoothstep(0.0, 0.25, t));
  c = mix(c, vec3(0.95, 0.15, 0.1), smoothstep(0.2, 0.55, t));
  c = mix(c, vec3(1.0, 0.65, 0.0), smoothstep(0.5, 0.8, t));
  c = mix(c, vec3(1.0, 1.0, 0.75), smoothstep(0.8, 1.0, t));
  return c * 1.3;
}

vec3 waxNormal(vec3 p) {
  float e = uVoxel * 1.1;
  vec3 g = vec3(
    dens(p + vec3(e, 0, 0)) - dens(p - vec3(e, 0, 0)),
    dens(p + vec3(0, e, 0)) - dens(p - vec3(0, e, 0)),
    dens(p + vec3(0, 0, e)) - dens(p - vec3(0, 0, e)));
  return -normalize(g + vec3(0.0, 1e-6, 0.0));
}

vec3 waxShade(vec3 p, vec3 n, vec3 v) {
  vec4 fOut = field(p + n * 0.0025);
  vec4 fIn = field(p - n * 0.005);
  vec4 fDeep = field(p - n * 0.011);
  float temp = field(p - n * 0.002).b;
  vec3 l = normalize(BULB - p);
  float B = bulbAt(p);
  float Lout = fOut.g, Lin = fIn.g;

  vec3 alb = uWax;
  vec3 deep = alb * alb;                // multiple scattering saturates the colour
  float ndl = dot(n, l);
  float wrap = max(0.0, (ndl + 0.45) / 1.45);
  vec3 c = alb * B * Lout * wrap * 0.85;
  // light diffusing through the wax body (translucency), stronger for thin parts
  c += deep * B * (Lin * 0.55 + fDeep.g * 0.25);
  // forward scattering at the silhouette when backlit
  float nv = clamp(dot(n, v), 0.0, 1.0);
  float rim = pow(1.0 - nv, 2.5);
  c += alb * B * Lout * rim * 0.45;
  // ambient light from the room (diffuse env)
  c += alb * envLod(n, 6.0) * uAmbient;
  // light bounced around inside the liquid
  c += alb * uLiquid * B * 0.04;
  // hot wax is slightly more luminous / translucent
  c *= mix(0.85, 1.12, smoothstep(0.38, 0.65, temp));
  // specular: wax/water interface is weak but visible
  vec3 r = reflect(-v, n);
  float F = 0.025 + 0.25 * pow(1.0 - nv, 5.0);
  c += F * envLod(r, 1.5);
  c += uBulbColor * B * Lout * pow(max(dot(r, l), 0.0), 40.0) * 0.35;
  if (uThermal > 0.5) c = thermal(temp) * (0.35 + 0.65 * wrap) * (0.4 + 0.6 * Lout) + rim * 0.2;
  return c;
}

vec3 marchLiquid(vec3 p0, vec3 rd) {
  vec3 acc = vec3(0.0);
  vec3 T = vec3(1.0);
  vec3 sigA = (vec3(1.0) - uLiquid) * uLiquidDensity + 0.6;
  vec3 scatterCol = uLiquid * uScatter;
  float H = uProf2.w;
  float jit = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0);
  float t = 0.0006 + jit * 0.0012;
  float dt = 0.0012, lastDt = 0.0;
  int hit = 0;
  vec3 p = p0;
  int maxSteps = int(uSteps);
  for (int i = 0; i < 240; i++) {
    if (i >= maxSteps) break;
    p = p0 + rd * t;
    if (sdIn(p) > 0.0 || p.y < 0.0 || p.y > H) break;
    vec4 f = field(p);
    if (f.r > uIso) { hit = 1; break; }
    if (p.y < 0.012) {
      float dc = sdCoil(p);
      if (dc < 0.00015) { hit = 2; break; }
      dt = clamp(dc, 0.0002, 0.0025);
    } else {
      dt = mix(0.0032, 0.0011, smoothstep(0.0, uIso, f.r));
    }
    float L = bulbAt(p) * f.g;
    // faint cloudiness + floating specks catch the light
    float speck = 0.0;
    vec3 cell = floor(p * 900.0 + vec3(0.0, uTime * 0.6, 0.0));
    float hs = hash13(cell);
    speck = step(0.9993, hs) * 40.0;
    acc += T * (scatterCol * (1.0 + uCloud) + uBulbColor * speck * 0.02) * L * dt;
    T *= exp(-sigA * dt);
    lastDt = dt;
    t += dt;
  }
  if (hit == 1) {
    float a = t - lastDt, b = t;
    for (int k = 0; k < 6; k++) { float m = 0.5 * (a + b); if (dens(p0 + rd * m) > uIso) b = m; else a = m; }
    p = p0 + rd * b;
    vec3 n = waxNormal(p);
    return acc + T * waxShade(p, n, -rd) * uWaxGain * 2.2;
  }
  if (hit == 2) {
    // dark wire silhouetted against the bulb, with glints
    float e = 0.0002;
    vec3 n = normalize(vec3(sdCoil(p + vec3(e,0,0)) - sdCoil(p - vec3(e,0,0)), sdCoil(p + vec3(0,e,0)) - sdCoil(p - vec3(0,e,0)), sdCoil(p + vec3(0,0,e)) - sdCoil(p - vec3(0,0,e))));
    vec3 l = normalize(BULB - p);
    float B = bulbAt(p) * field(p).g;
    vec3 r = reflect(rd, n);
    vec3 c = vec3(0.55, 0.5, 0.45) * (B * (0.04 + 0.6 * pow(max(dot(r, l), 0.0), 12.0)) + envLod(r, 2.0).r * 0.3);
    return acc + T * c;
  }
  if (p.y <= 0.0) {
    // looking down into the glowing bottom glass
    float L = bulbAt(vec3(p.x, 0.0, p.z)) * field(vec3(p.x, 0.001, p.z)).g;
    return acc + T * uBulbColor * L * 0.5;
  }
  if (p.y >= H) return acc + T * vec3(0.004);
  // exit through the far wall back into the room
  vec3 no = nIn(p);
  vec3 ro = refract(rd, -no, 1.333);
  vec3 bg;
  // total internal reflection at the far wall: the ray stays inside and picks up more liquid glow
  if (dot(ro, ro) < 0.5) bg = envLod(reflect(rd, -no), 1.0) * 0.25 + scatterCol * bulbAt(p) * field(p).g * 0.06;
  else bg = bgAt(p + no * uProf2.y, ro);
  return acc + T * bg;
}

void main() {
  vec3 P = vWorld - uGlobeOrigin;
  vec3 ro = cameraPosition - uGlobeOrigin;
  vec3 rd = normalize(P - ro);
  vec3 N = normalize(vNormalW);
  if (dot(N, rd) > 0.0) N = -N;
  float cosi = clamp(dot(-rd, N), 0.0, 1.0);
  float Fr = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
  vec3 refl = envLod(reflect(rd, N), 0.0);

  vec3 rg = refract(rd, N, 1.0 / 1.5);
  float t = 0.0;
  bool inner = false;
  for (int i = 0; i < 56; i++) { t += 0.00035; if (sdIn(P + rg * t) < 0.0) { inner = true; break; } }
  vec3 col;
  if (!inner) {
    // grazing ray that stays inside the glass wall
    col = bgAt(P + rg * t, rg) * vec3(0.55, 0.62, 0.6);
  } else {
    float a = t - 0.00035, b = t;
    for (int k = 0; k < 6; k++) { float m = 0.5 * (a + b); if (sdIn(P + rg * m) < 0.0) b = m; else a = m; }
    vec3 pi = P + rg * b;
    vec3 ni = nIn(pi);
    vec3 rl = refract(rg, ni, 1.5 / 1.333);
    if (dot(rl, rl) < 0.5) col = bgAt(pi, rg) * vec3(0.55, 0.62, 0.6) + uLiquid * bulbAt(pi) * 0.05; // TIR: light stays in the glass
    else if (pi.y > uProf2.w) col = vec3(0.01); // air gap under the cap
    else col = marchLiquid(pi, rl);
  }
  vec3 c = col * (1.0 - Fr) + refl * Fr;
  gl_FragColor = vec4(c, 1.0);
}`;

// Final photographic grade on the HDR buffer: ACES tone mapping, sRGB, vignette,
// subtle chromatic aberration and film grain (which also dithers away banding).
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uExposure: { value: 1 }, uGrain: { value: 0.03 }, uVignette: { value: 0.32 }, uCA: { value: 0.0012 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uExposure, uGrain, uVignette, uCA; varying vec2 vUv;
    float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
    vec3 aces(vec3 color){
      const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color *= uExposure / 0.6;
      color = ACESInputMat * color; color = RRTAndODTFit(color); color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * r2 * uCA * 8.0;
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - off).b;
      c *= 1.0 - uVignette * smoothstep(0.08, 0.6, r2);
      c = toSRGB(aces(c));
      float g = h(gl_FragCoord.xy + fract(uTime) * 517.0) - 0.5;
      float g2 = h(gl_FragCoord.yx * 1.37 + fract(uTime * 1.3) * 211.0) - 0.5;
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      c += g * uGrain * (1.0 - lum * 0.6) + (g2) / 255.0;
      gl_FragColor = vec4(c, 1.0);
    }`
};
